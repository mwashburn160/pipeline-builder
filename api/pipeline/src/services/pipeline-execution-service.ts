// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  CodePipelineClient,
  StartPipelineExecutionCommand,
  StopPipelineExecutionCommand,
} from '@aws-sdk/client-codepipeline';
import { pipelineRegistryService } from './pipeline-registry-service.js';

// Error-code constants (mirrors the `PR_*` convention in the registry service).
// Routes map these to HTTP status codes; the raw AWS client internals never
// reach the caller.
export const PE_PIPELINE_NOT_REGISTERED = 'PE_PIPELINE_NOT_REGISTERED';
export const PE_AWS_PIPELINE_NOT_FOUND = 'PE_AWS_PIPELINE_NOT_FOUND';
export const PE_NOT_STOPPABLE = 'PE_NOT_STOPPABLE';
export const PE_AWS_ERROR = 'PE_AWS_ERROR';

/**
 * Error carrying a sanitized AWS failure. `awsName`/`awsMessage` are the AWS
 * error's `name`/`message` — safe to log, but never the raw client internals.
 */
export class PipelineExecutionError extends Error {
  readonly awsName?: string;
  readonly awsMessage?: string;
  constructor(code: string, awsName?: string, awsMessage?: string) {
    super(code);
    this.name = 'PipelineExecutionError';
    this.awsName = awsName;
    this.awsMessage = awsMessage;
  }
}

/** The `name` AWS SDK stamps on a given exception (used to classify failures). */
function awsErrorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err) {
    return String((err as { name: unknown }).name);
  }
  return undefined;
}

function awsErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  return undefined;
}

class PipelineExecutionService {
  // Per-region client cache — CodePipelineClient is thread-safe and reusable, so
  // one client per region is cheaper than constructing per call.
  private readonly clients = new Map<string, CodePipelineClient>();

  private clientFor(region: string): CodePipelineClient {
    let client = this.clients.get(region);
    if (!client) {
      // Credentials come from the default AWS provider chain (Pod Identity at
      // runtime) — never pass explicit credentials.
      client = new CodePipelineClient({ region });
      this.clients.set(region, client);
    }
    return client;
  }

  /** Resolve the registry row → CodePipeline client for the caller's org. */
  private async resolve(pipelineId: string, orgId: string) {
    const row = await pipelineRegistryService.findByPipelineId(pipelineId, orgId);
    if (!row) throw new PipelineExecutionError(PE_PIPELINE_NOT_REGISTERED);
    // A pipeline may be deployed to a different region than the platform; fall
    // back to the pod's AWS_REGION only when the registry row has none.
    const region = row.region || process.env.AWS_REGION || '';
    return { row, client: this.clientFor(region) };
  }

  /**
   * Start a new CodePipeline execution for a registered pipeline.
   * @throws PipelineExecutionError(PE_PIPELINE_NOT_REGISTERED) when the pipeline
   *   isn't registered to the caller's org.
   * @throws PipelineExecutionError(PE_AWS_PIPELINE_NOT_FOUND) when the registry
   *   name no longer resolves in AWS (stale registry).
   * @throws PipelineExecutionError(PE_AWS_ERROR) for other AWS failures.
   */
  async triggerExecution(pipelineId: string, orgId: string): Promise<{ executionId: string }> {
    const { row, client } = await this.resolve(pipelineId, orgId);
    try {
      const out = await client.send(new StartPipelineExecutionCommand({ name: row.pipelineName }));
      return { executionId: out.pipelineExecutionId ?? '' };
    } catch (err) {
      if (awsErrorName(err) === 'PipelineNotFoundException') {
        throw new PipelineExecutionError(PE_AWS_PIPELINE_NOT_FOUND, awsErrorName(err), awsErrorMessage(err));
      }
      throw new PipelineExecutionError(PE_AWS_ERROR, awsErrorName(err), awsErrorMessage(err));
    }
  }

  /**
   * Stop an in-flight CodePipeline execution.
   * @throws PipelineExecutionError(PE_PIPELINE_NOT_REGISTERED) when unregistered.
   * @throws PipelineExecutionError(PE_NOT_STOPPABLE) when AWS says the execution
   *   is not in a stoppable state (already finished / not stoppable).
   * @throws PipelineExecutionError(PE_AWS_PIPELINE_NOT_FOUND) on stale registry.
   * @throws PipelineExecutionError(PE_AWS_ERROR) for other AWS failures.
   */
  async stopExecution(
    pipelineId: string,
    orgId: string,
    executionId: string,
    opts?: { reason?: string; abandon?: boolean },
  ): Promise<void> {
    const { row, client } = await this.resolve(pipelineId, orgId);
    try {
      await client.send(new StopPipelineExecutionCommand({
        pipelineName: row.pipelineName,
        pipelineExecutionId: executionId,
        reason: opts?.reason,
        abandon: opts?.abandon,
      }));
    } catch (err) {
      const name = awsErrorName(err);
      if (name === 'PipelineExecutionNotStoppableException') {
        throw new PipelineExecutionError(PE_NOT_STOPPABLE, name, awsErrorMessage(err));
      }
      if (name === 'PipelineNotFoundException') {
        throw new PipelineExecutionError(PE_AWS_PIPELINE_NOT_FOUND, name, awsErrorMessage(err));
      }
      throw new PipelineExecutionError(PE_AWS_ERROR, name, awsErrorMessage(err));
    }
  }
}

export const pipelineExecutionService = new PipelineExecutionService();
