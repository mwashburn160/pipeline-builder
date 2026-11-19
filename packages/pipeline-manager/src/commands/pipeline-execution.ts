// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline run` / `pipeline stop` — start or stop a deployed pipeline with the
 * operator's OWN AWS credentials (for teams that want no runner at all). The
 * platform is only asked where the pipeline is (its registry row: CodePipeline
 * name + region); every AWS call is local.
 *
 * Before acting, the pipeline's `pb.pipeline-id` tag must equal the platform
 * pipeline id: a stale registry row, or a different pipeline that now carries
 * the name, is refused rather than started.
 */

import { randomUUID } from 'node:crypto';
import {
  CodePipelineClient, GetPipelineCommand, GetPipelineExecutionCommand, StartPipelineExecutionCommand, StopPipelineExecutionCommand,
} from '@aws-sdk/client-codepipeline';
import { PIPELINE_ID_TAG } from '@pipeline-builder/api-core/pipeline-runners';
import { Command } from 'commander';
import { readPipelineIdTag, type Sender } from '../lambda/pipeline-tag.js';
import { applyAwsProfile, resolveDeployRegion } from '../utils/aws-env.js';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning, validateEntityId, withProfileOption, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printInfo, printSuccess } from '../utils/output-utils.js';
import { extractListPage } from '../utils/response-utils.js';

const REGISTRY_PAGE_LIMIT = 500;

export type { Sender };

/** The registry fields this command reads. */
export interface RegistryLocation { pipelineId: string; pipelineName: string; region?: string | null }

/** Minimal platform client surface (ApiClient satisfies it). */
export interface RegistryReader { get<T = unknown>(url: string, params?: Record<string, unknown>): Promise<T> }

/** Find the pipeline's registry row (CodePipeline name + region), paging the org's registry. */
export async function findRegistryLocation(client: RegistryReader, pipelineUrl: string, pipelineId: string): Promise<RegistryLocation | undefined> {
  for (let offset = 0; ;) {
    const res = await client.get(`${pipelineUrl}/registry`, { limit: REGISTRY_PAGE_LIMIT, offset });
    const page = extractListPage<RegistryLocation>(res, 'registry');
    const hit = page.items.find((r) => r.pipelineId === pipelineId);
    if (hit) return hit;
    offset += page.items.length;
    if (!page.hasMore || page.items.length === 0) return undefined;
  }
}

export interface ExecutionDeps {
  /** Platform registry lookup. */
  locate: (pipelineId: string) => Promise<RegistryLocation | undefined>;
  /** CodePipeline client for a region (the operator's own credentials). */
  codepipeline: (region: string) => Sender;
  /** Region when neither --region nor the registry row names one (resolveDeployRegion). */
  fallbackRegion: () => Promise<string>;
  newToken: () => string;
}

export interface ResolvedPipeline { name: string; region: string }

/**
 * Resolve the pipeline and PROVE its identity: GetPipeline → its ARN →
 * ListTagsForResource → `pb.pipeline-id` must equal `pipelineId`.
 * Region: `--region` → the registry row → the resolveDeployRegion chain.
 */
export async function resolveVerifiedPipeline(deps: ExecutionDeps, pipelineId: string, regionOverride?: string): Promise<ResolvedPipeline> {
  const row = await deps.locate(pipelineId);
  if (!row?.pipelineName) {
    throw new ValidationError(
      `Pipeline ${pipelineId} has no deployment registered on the platform — deploy it with "pipeline-manager pipeline deploy", `
      + 'or register it with "pipeline-manager pipeline register".', 'id');
  }
  const region = regionOverride || row.region || await deps.fallbackRegion();
  const cp = deps.codepipeline(region);
  let arn: string | undefined;
  try {
    const got = await cp.send(new GetPipelineCommand({ name: row.pipelineName })) as { metadata?: { pipelineArn?: string } };
    arn = got.metadata?.pipelineArn;
  } catch (err) {
    if ((err as { name?: string })?.name === 'PipelineNotFoundException') {
      throw new ValidationError(`CodePipeline "${row.pipelineName}" was not found in ${region} with your AWS credentials (wrong account or region? pass --region / --profile)`, 'id');
    }
    throw err;
  }
  if (!arn) throw new Error(`CodePipeline "${row.pipelineName}" returned no ARN`);

  const tag = await readPipelineIdTag(cp, arn);
  if (tag === undefined) {
    throw new ValidationError(
      `CodePipeline "${row.pipelineName}" in ${region} carries no ${PIPELINE_ID_TAG} tag, so it cannot be proven to be pipeline ${pipelineId}. `
      + 'Redeploy it with "pipeline-manager pipeline deploy".', 'id');
  }
  if (tag !== pipelineId) {
    throw new ValidationError(
      `CodePipeline "${row.pipelineName}" in ${region} belongs to a different platform pipeline (${PIPELINE_ID_TAG} does not match ${pipelineId}) — refusing to act on it.`, 'id');
  }
  return { name: row.pipelineName, region };
}

/** Start an execution (after the tag check). */
export async function startPipelineRun(deps: ExecutionDeps, pipelineId: string, regionOverride?: string): Promise<ResolvedPipeline & { executionId?: string }> {
  const p = await resolveVerifiedPipeline(deps, pipelineId, regionOverride);
  const out = await deps.codepipeline(p.region).send(new StartPipelineExecutionCommand({
    name: p.name, clientRequestToken: deps.newToken(),
  })) as { pipelineExecutionId?: string };
  return { ...p, executionId: out.pipelineExecutionId };
}

/** Stop an execution of this pipeline (after the tag check and a check the execution is this pipeline's). */
export async function stopPipelineRun(
  deps: ExecutionDeps, pipelineId: string, executionId: string, opts: { regionOverride?: string; abandon?: boolean; reason?: string } = {},
): Promise<ResolvedPipeline & { executionId: string }> {
  const p = await resolveVerifiedPipeline(deps, pipelineId, opts.regionOverride);
  const cp = deps.codepipeline(p.region);
  try {
    await cp.send(new GetPipelineExecutionCommand({ pipelineName: p.name, pipelineExecutionId: executionId }));
  } catch (err) {
    if ((err as { name?: string })?.name === 'PipelineExecutionNotFoundException') {
      throw new ValidationError(`Execution ${executionId} does not belong to pipeline ${pipelineId}`, 'execution');
    }
    throw err;
  }
  await cp.send(new StopPipelineExecutionCommand({
    pipelineName: p.name,
    pipelineExecutionId: executionId,
    abandon: !!opts.abandon,
    reason: (opts.reason ?? 'Stopped with pipeline-manager pipeline stop').slice(0, 200),
  }));
  return { ...p, executionId };
}

/** Real dependencies for the commands. */
async function realDeps(options: { verifySsl?: boolean; profile?: string; region?: string }): Promise<ExecutionDeps> {
  // Before any SDK client exists, or --profile is silently dropped.
  applyAwsProfile(options.profile);
  const client = await createAuthenticatedClientAsync(options);
  const pipelineUrl = client.getConfig().api.pipelineUrl;
  const clients = new Map<string, CodePipelineClient>();
  return {
    locate: (id) => findRegistryLocation(client, pipelineUrl, id),
    codepipeline: (region) => {
      if (!clients.has(region)) clients.set(region, new CodePipelineClient({ region }));
      return clients.get(region)!;
    },
    fallbackRegion: () => resolveDeployRegion(undefined, options.profile),
    newToken: () => randomUUID(),
  };
}

function withCommon<T extends Command>(cmd: T): T {
  return withProfileOption(withSslOptions(cmd))
    .option('--region <region>', 'CodePipeline region (default: the region the platform recorded at deploy, else AWS_REGION / the profile\'s region)')
    .option('--json', 'Output result as JSON', false) as T;
}

/**
 * Registers `pipeline run`.
 *
 * @example
 * ```bash
 * pipeline-manager pipeline run --id <pipelineId> --profile customer-account
 * ```
 */
export function runPipeline(program: Command): void {
  withCommon(program
    .command('run')
    .description('Start a deployed pipeline with your own AWS credentials (checks its pb.pipeline-id tag first)')
    .requiredOption('-i, --id <id>', 'Pipeline ID'))
    .action(async (options) => {
      const executionId = printCommandHeader('Run Pipeline', undefined, { quiet: options.json });
      try {
        printSslWarning(options.verifySsl);
        const id = validateEntityId(options.id, 'Pipeline');
        const deps = await realDeps(options);
        const r = await startPipelineRun(deps, id, options.region);
        if (options.json) {
          console.log(JSON.stringify({ success: true, pipelineId: id, pipelineName: r.name, region: r.region, executionId: r.executionId ?? null }, null, 2));
        } else {
          printSuccess('Pipeline execution started', { pipelineName: r.name, region: r.region, executionId: r.executionId });
          printInfo(`Stop it with: pipeline-manager pipeline stop --id ${id} --execution ${r.executionId ?? '<executionId>'}`);
        }
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, { exit: true, context: { command: 'pipeline-run', executionId, pipelineId: options.id } });
      }
    });
}

/**
 * Registers `pipeline stop`.
 *
 * @example
 * ```bash
 * pipeline-manager pipeline stop --id <pipelineId> --execution <executionId>
 * ```
 */
export function stopPipeline(program: Command): void {
  withCommon(program
    .command('stop')
    .description('Stop a running execution with your own AWS credentials (checks its pb.pipeline-id tag first)')
    .requiredOption('-i, --id <id>', 'Pipeline ID')
    .requiredOption('-e, --execution <executionId>', 'CodePipeline execution ID')
    .option('--abandon', 'Abandon in-progress actions instead of letting them finish', false)
    .option('--reason <text>', 'Reason recorded on the stopped execution'))
    .action(async (options) => {
      const executionId = printCommandHeader('Stop Pipeline', undefined, { quiet: options.json });
      try {
        printSslWarning(options.verifySsl);
        const id = validateEntityId(options.id, 'Pipeline');
        const deps = await realDeps(options);
        const r = await stopPipelineRun(deps, id, String(options.execution), { regionOverride: options.region, abandon: options.abandon, reason: options.reason });
        if (options.json) {
          console.log(JSON.stringify({ success: true, pipelineId: id, pipelineName: r.name, region: r.region, executionId: r.executionId, stopped: true }, null, 2));
        } else {
          printSuccess('Stop requested', { pipelineName: r.name, region: r.region, executionId: r.executionId });
        }
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, { exit: true, context: { command: 'pipeline-stop', executionId, pipelineId: options.id } });
      }
    });
}
