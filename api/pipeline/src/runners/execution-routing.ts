// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner branch of the execution start/stop paths. Only reached when the
 * deployment has a runner signing key (`runnersAvailable`); otherwise the
 * callers run today's platform-account code untouched. Per org, the
 * `cross_account_runners` feature decides (see `orgHasFeature`).
 */

import { errorMessage } from '@pipeline-builder/api-core';
import { runnerDeps, runnerTablesPresent, type RunnerDeps } from './deps.js';
import { discoverRunner, eligibleRunners, enqueueRun, linkedRunner, RunnerRouteError, type EligibleRunner, type QueuedRun, type RouteInput } from './routing.js';
import { PE_AWS_ERROR, PE_AWS_PIPELINE_NOT_FOUND, PE_PIPELINE_NOT_REGISTERED } from '../services/pipeline-execution-service.js';
import { pipelineService } from '../services/pipeline-service.js';

/** AWS SDK error names meaning "this process has no usable AWS credentials". */
const CREDENTIAL_ERRORS = new Set(['CredentialsProviderError', 'CredentialsError', 'ExpiredTokenException', 'UnrecognizedClientException', 'InvalidClientTokenId']);

/** Whether a platform-path failure is a credential problem (no usable platform AWS creds). */
export function isCredentialError(err: unknown): boolean {
  const name = (err as { awsName?: unknown })?.awsName;
  const message = String((err as { awsMessage?: unknown })?.awsMessage ?? '');
  return (typeof name === 'string' && CREDENTIAL_ERRORS.has(name)) || /could not load credentials|region is missing/i.test(message);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RoutedOutcome<T> = { kind: 'platform'; value: T } | ({ kind: 'queued' } & QueuedRun);

/**
 * Route one start/stop. `viaPlatform` is today's call (platform AWS creds); it
 * runs unless the pipeline is linked to an eligible runner, and its "not
 * found" answers start discovery.
 */
export async function routeExecution<T>(
  input: RouteInput,
  viaPlatform: () => Promise<T>,
  deps: RunnerDeps = runnerDeps(),
): Promise<RoutedOutcome<T>> {
  // A malformed id: exactly today's answer.
  if (!UUID.test(input.pipelineId)) return { kind: 'platform', value: await viaPlatform() };

  // An org WITHOUT the feature: today's path — no runner table read, no
  // discovery. Only a pipeline still LINKED to a runner (the org lost the
  // feature) is refused, never silently sent the platform way. That refusal
  // is why this one read stays: a link outlives the feature, and the only way
  // to know it without asking first is to try the platform path — which is the
  // silent fallback the contract forbids. It is one indexed pipeline_registry
  // row (no runner table), and it fails open on a database without the column.
  if (input.orgHasFeature === false) {
    await deps.noteOrgFeature(input.orgId, false);
    const link = await deps.store.getRegistryLink(input.pipelineId, input.orgId).catch(() => null);
    if (link?.runnerId && (await pipelineService.findById(input.pipelineId, input.orgId))) {
      throw new RunnerRouteError('RUNNERS_NOT_ENABLED', 'This pipeline runs through a cross-account runner, and cross-account runners are not enabled for your organization.');
    }
    return { kind: 'platform', value: await viaPlatform() };
  }
  await deps.noteOrgFeature(input.orgId, true);
  // A database created before runners (no runner tables): runners are
  // unavailable, so this is today's path exactly — never a 500.
  if (!(await runnerTablesPresent(deps))) return { kind: 'platform', value: await viaPlatform() };
  // A pipeline the caller cannot see: exactly today's answer.
  if (!(await pipelineService.findById(input.pipelineId, input.orgId))) throw new Error(PE_PIPELINE_NOT_REGISTERED); // the routes map it by message, like PipelineExecutionError

  const link = await deps.store.getRegistryLink(input.pipelineId, input.orgId);
  let eligible: EligibleRunner[] | undefined;
  const loadEligible = async () => (eligible ??= await eligibleRunners(deps, input.orgId, input.parentOrgId));

  if (link?.runnerId) {
    const runner = await linkedRunner(deps, link, await loadEligible());
    if (runner) return { kind: 'queued', ...await enqueueRun(deps, runner, input) };
  }
  try {
    return { kind: 'platform', value: await viaPlatform() };
  } catch (err) {
    const code = errorMessage(err);
    // No usable platform AWS credentials is the same answer as "not in the
    // platform account": ask the runners (never a 502 for it).
    const notHere = code === PE_AWS_PIPELINE_NOT_FOUND || (code === PE_AWS_ERROR && isCredentialError(err));
    if (!notHere && code !== PE_PIPELINE_NOT_REGISTERED) throw err;
    const runners = await loadEligible();
    // Not registered and no runner to ask: today's 404, unchanged.
    if (code === PE_PIPELINE_NOT_REGISTERED && runners.length === 0) throw err;
    const runner = await discoverRunner(deps, input, runners, link);
    return { kind: 'queued', ...await enqueueRun(deps, runner, input) };
  }
}
