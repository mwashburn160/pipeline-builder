// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every start and stop goes through a runner: the platform never has pipelines
 * in its own AWS account. A linked, eligible runner gets the request; an
 * unlinked pipeline goes straight to discovery (nearest level wins). The answer
 * is always a queued run request the caller polls at
 * `GET /pipelines/:pipelineId/run-requests/:requestId`.
 */

import { runnerDeps, type RunnerDeps } from './deps.js';
import {
  discoverRunner, eligibleRunners, enqueueRun, linkedRunner, RunnerRouteError, runnersUnavailable, RUNNERS_UNAVAILABLE_MESSAGES, type EligibleRunner, type QueuedRun, type RouteInput,
} from './routing.js';
import { pipelineService } from '../services/pipeline-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A stop's execution id: a CodePipeline execution id, within the run-request column (varchar(100)). */
const EXECUTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** 409 RUNNERS_UNAVAILABLE unless the deployment can sign and deliver right now. */
export async function assertRunnersAvailable(deps: RunnerDeps): Promise<void> {
  const state = await deps.runnersAvailable();
  if (state.available) return;
  throw runnersUnavailable(state.reason && Object.hasOwn(RUNNERS_UNAVAILABLE_MESSAGES, state.reason) ? state.reason : 'paused');
}

/**
 * Route one start/stop to a runner and queue it.
 *
 * - A malformed pipeline id or stop execution id → 400 VALIDATION_ERROR (nothing is read).
 * - Runners unavailable (paused, no secret encryption, no tables) → 409 RUNNERS_UNAVAILABLE.
 * - A pipeline the caller cannot see → 404 NOT_FOUND (no runner is asked).
 * - Linked to an eligible runner → queued for it (409 RUNNER_UNREACHABLE when unhealthy).
 * - Otherwise discovery (see {@link discoverRunner}).
 */
export async function routeExecution(input: RouteInput, deps: RunnerDeps = runnerDeps()): Promise<QueuedRun> {
  if (!UUID.test(input.pipelineId)) throw new RunnerRouteError('VALIDATION_ERROR', 'Pipeline id must be a UUID.');
  if (input.executionId !== undefined && !EXECUTION_ID.test(input.executionId)) throw new RunnerRouteError('VALIDATION_ERROR', 'Execution id is malformed.');
  await assertRunnersAvailable(deps);
  if (!(await pipelineService.findById(input.pipelineId, input.orgId))) throw new RunnerRouteError('NOT_FOUND', 'Pipeline not found.');

  const link = await deps.store.getRegistryLink(input.pipelineId, input.orgId);
  let eligible: EligibleRunner[] | undefined;
  const loadEligible = async () => (eligible ??= await eligibleRunners(deps, input.orgId, input.parentOrgId));

  if (link?.runnerId) {
    const runner = await linkedRunner(deps, link, await loadEligible());
    if (runner) return enqueueRun(deps, runner, input);
  }
  let candidates = await loadEligible();
  if (input.runnerId) {
    const wanted = input.runnerId.toLowerCase();
    candidates = candidates.filter((e) => e.runner.id.toLowerCase() === wanted);
    if (candidates.length === 0) throw new RunnerRouteError('VALIDATION_ERROR', 'runnerId names no pipeline runner your organization can use.');
  }
  const runner = await discoverRunner(deps, input, candidates, link);
  return enqueueRun(deps, runner, input);
}
