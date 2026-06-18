// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parsePlatformBaseUrl } from '@pipeline-builder/pipeline-core';
import { printInfo } from './output-utils.js';

/**
 * Helpers for registering a deployed pipeline ARN with the platform.
 *
 * The registry table maps deployed CodePipeline ARNs back to pipeline records
 * and orgs. It's how the dashboard's "Deployed pipelines" panel and the event
 * reporting Lambda resolve incoming events to a pipeline definition.
 *
 * Two failure modes are handled here:
 *
 *   1. Platform unreachable at deploy time. The CDK stack lands in AWS but the
 *      registry POST fails. Without retry the deploy command would have to
 *      re-run cdk-deploy (slow, sometimes blocked by stack state) just to
 *      record the ARN. Instead, we write a pending intent to a local file;
 *      `pipeline-manager register` drains them.
 *
 *   2. User explicitly invokes `pipeline-manager register --id <pipelineId>`
 *      after a successful deploy that didn't register. Same path: rebuilds
 *      the ARN from STS, POSTs to the platform.
 *
 * Pending intents store ONLY the registration payload — never tokens or URLs.
 * Auth is supplied by whichever command drains the intent (deploy or register),
 * so a stale intent file is never an authentication risk.
 */

/**
 * Platform-sourced registry pull target for the CDK synth, derived from the
 * platform base URL the CLI deploys against (the same host that serves the
 * registry `/v2/` data path via nginx). Reuses pipeline-core's
 * `parsePlatformBaseUrl` so host/port parsing stays identical on both sides.
 * Returns `undefined` for an unparseable/absent URL. (Only the pull host/port
 * are returned — `registry.http` describes the in-cluster push hop, which the
 * synth never reads, so deriving it from the public URL would be misleading.)
 */
export function registryOverrideFromBaseUrl(
  baseUrl: string | undefined,
): { pullHost: string; pullPort: number } | undefined {
  const parsed = parsePlatformBaseUrl(baseUrl);
  return parsed ? { pullHost: parsed.host, pullPort: parsed.port } : undefined;
}

/**
 * Bake the platform-derived registry pull target into the synth props
 * (`BuilderProps.registry`) so the CodeBuild image URIs use a host AWS CodeBuild
 * can resolve — not the in-cluster `registry:5000` default. Shared by the
 * `deploy` and `synth` commands.
 *
 * An explicit `IMAGE_REGISTRY_PULL_HOST` in the synth env takes precedence, so
 * this is a no-op when it is set (the synth's `loadRegistryConfig` already
 * honors it). Also a no-op for an unparseable/absent base URL.
 */
export function bakePlatformRegistry(props: Record<string, unknown>, baseUrl: string | undefined): void {
  if (process.env.IMAGE_REGISTRY_PULL_HOST) return; // explicit env wins
  const override = registryOverrideFromBaseUrl(baseUrl);
  if (!override) return;
  props.registry = override;
  printInfo('Registry pull target', { host: override.pullHost, port: override.pullPort });
}

/** Shape of the body POSTed to /api/pipelines/registry. */
export interface RegistryPayload {
  pipelineId: string;
  orgId: string;
  pipelineName: string;
  region: string;
  project: string;
  organization: string;
  stackName: string;
}

/** Pipeline fields needed to construct a RegistryPayload. */
export interface PipelineForRegistry {
  id: string;
  orgId: string;
  pipelineName?: string;
  project: string;
  organization: string;
}

/** Where pending registration intents are persisted between CLI invocations. */
const PENDING_INTENTS_DIR = join(homedir(), '.pipeline-manager', 'pending-registrations');

/**
 * Build a RegistryPayload from the platform's pipeline metadata. No AWS calls
 * and no ARN/account: the events Lambda attributes events via the pipeline's
 * `PIPELINE_EVENT_ID` tag (= pipelineId), so the registry only needs the stable
 * pipelineId + display metadata.
 */
export async function buildRegistryPayload(
  pipeline: PipelineForRegistry,
  regionOverride?: string,
): Promise<RegistryPayload> {
  const region = regionOverride
    || process.env.AWS_REGION
    || process.env.CDK_DEFAULT_REGION
    || 'us-east-1';

  const pipelineName = pipeline.pipelineName
    || `${pipeline.organization}-${pipeline.project}-pipeline`.toLowerCase();
  const stackName = `${pipeline.project}-${pipeline.organization}`.toLowerCase();

  return {
    pipelineId: pipeline.id,
    orgId: pipeline.orgId,
    pipelineName,
    region,
    project: pipeline.project,
    organization: pipeline.organization,
    stackName,
  };
}

/**
 * Persist a registration intent for later retry.
 *
 * Intent files are keyed by pipelineId so re-running deploy on the same
 * pipeline overwrites rather than accumulates. We deliberately store the
 * payload plain (not the full pipeline doc, not auth) so a stale file is
 * safe to leave around indefinitely.
 */
export async function writePendingIntent(payload: RegistryPayload): Promise<string> {
  await fs.mkdir(PENDING_INTENTS_DIR, { recursive: true });
  const path = join(PENDING_INTENTS_DIR, `${payload.pipelineId}.json`);
  await fs.writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  return path;
}

/** Remove a pending intent after a successful drain. */
export async function clearPendingIntent(pipelineId: string): Promise<void> {
  const path = join(PENDING_INTENTS_DIR, `${pipelineId}.json`);
  try {
    await fs.unlink(path);
  } catch (err) {
    // ENOENT is fine — already cleared. Anything else is a real problem.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Read all pending intents currently on disk. Empty array if dir doesn't exist. */
export async function readPendingIntents(): Promise<RegistryPayload[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PENDING_INTENTS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const intents: RegistryPayload[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    try {
      const text = await fs.readFile(join(PENDING_INTENTS_DIR, file), 'utf8');
      intents.push(JSON.parse(text) as RegistryPayload);
    } catch {
      // Skip unreadable / malformed files — they'll need manual cleanup but
      // shouldn't block valid intents from draining.
    }
  }
  return intents;
}
