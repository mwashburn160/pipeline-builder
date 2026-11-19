// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which runner (if any) a start/stop for pipeline P in org O goes through.
 *
 *  1. The registry links P to a runner that is ELIGIBLE (O's own, or an
 *     ancestor's shared with teams; active) → enqueue for it — or refuse with
 *     409 RUNNER_UNREACHABLE when it is unhealthy (never a silent queue).
 *  2. Otherwise the platform-account path runs, exactly as before. Only when it
 *     answers "no such pipeline" does discovery start: O's eligible runners are
 *     probed in parallel (signed `probe`), and exactly ONE `match` links P to
 *     that runner and enqueues; more than one → 409 AMBIGUOUS_RUNNER; none →
 *     404 PIPELINE_NOT_FOUND_IN_RUNNERS; O has no runner → 409 NO_RUNNER.
 *
 * Inheritance order: own runners first, then each ancestor's shared runners,
 * nearest ancestor first.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { runnerErrorStatus, type PendingRunRequestStatus, type RunnerApiErrorCode, type RunnerReplyErrorCode } from '@pipeline-builder/api-core/pipeline-runners';
import { deliverPush } from './delivery.js';
import type { RunnerDeps } from './deps.js';
import { recordRunnerFailure, recordRunnerSuccess, updateGraceExpired } from './lifecycle.js';
import type { RegistryLink, RunRequestRow, RunnerRow } from './store.js';
import { MAX_PENDING_PER_ORG, RUN_REQUESTS_PER_MINUTE, RUN_REQUEST_TTL_MS } from './vocabulary.js';

const logger = createLogger('runner-routing');

/** The generic (non-runner) codes a runner admin path also refuses with, and their HTTP status. */
const GENERIC_ROUTE_STATUS = { VALIDATION_ERROR: 400, NOT_FOUND: 404 } as const;

/** What a runner path refuses with: a runner catalog code, or one of the generic two. */
export type RunnerRouteCode = RunnerApiErrorCode | RunnerReplyErrorCode | keyof typeof GENERIC_ROUTE_STATUS;

/** A runner-path refusal: the error-envelope `code` (its HTTP status from the shared catalog), optional UI details. */
export class RunnerRouteError extends Error {
  readonly status: number;

  constructor(
    readonly code: RunnerRouteCode,
    message: string,
    readonly details?: { runnerLabel?: string; lastDeliveryAt?: string | null; runnersChecked?: string[] },
  ) {
    super(message);
    this.name = 'RunnerRouteError';
    this.status = code in GENERIC_ROUTE_STATUS
      ? GENERIC_ROUTE_STATUS[code as keyof typeof GENERIC_ROUTE_STATUS]
      : runnerErrorStatus(code as RunnerApiErrorCode | RunnerReplyErrorCode);
  }
}

/** A runner as routing sees it: the row plus the org it is inherited from (if any). */
export interface EligibleRunner {
  runner: RunnerRow;
  /** Distance up the hierarchy: 0 = own org, 1 = direct parent, … */
  depth: number;
}

/**
 * The runners org `orgId` may use, in routing order: its own active runners,
 * then each ancestor's active runners shared with teams, nearest first.
 */
export async function eligibleRunners(deps: RunnerDeps, orgId: string, parentOrgId?: string): Promise<EligibleRunner[]> {
  const ancestors = await deps.hierarchy.ancestors(orgId, parentOrgId);
  const rows = await deps.store.listRunners([orgId, ...ancestors], { activeOnly: true });
  const out: EligibleRunner[] = [];
  const own = rows.filter((r) => r.orgId === orgId);
  for (const r of own) out.push({ runner: r, depth: 0 });
  ancestors.forEach((a, i) => {
    for (const r of rows) if (r.orgId === a && r.shareWithTeams) out.push({ runner: r, depth: i + 1 });
  });
  return out;
}

/** Whether `runner` is usable by `orgId` given its eligible set. */
function isEligible(runner: RunnerRow | null, eligible: EligibleRunner[]): runner is RunnerRow {
  return !!runner && eligible.some((e) => e.runner.id === runner.id);
}

function unhealthy(runner: RunnerRow): RunnerRouteError {
  return new RunnerRouteError('RUNNER_UNREACHABLE', `Pipeline runner "${runner.label}" is unreachable; runs through it are paused until it answers again.`, {
    runnerLabel: runner.label,
    lastDeliveryAt: runner.lastDeliveryAt ? runner.lastDeliveryAt.toISOString() : null,
  });
}

export interface RouteInput {
  pipelineId: string;
  orgId: string;
  parentOrgId?: string;
  requestedBy: string;
  action: 'start' | 'stop';
  executionId?: string;
  /**
   * The caller's org holds `cross_account_runners` (from the request's token).
   * Absent = held (system paths re-checked per job).
   */
  orgHasFeature?: boolean;
}

/** The queued answer of a runner-routed start/stop (`delivering` when an in-flight start was reused). */
export interface QueuedRun {
  requestId: string;
  status: PendingRunRequestStatus;
  runnerLabel: string;
  runnerId: string;
  /** An already-pending start of the same pipeline was returned instead of a new one (G12). */
  reused: boolean;
}

/** A Postgres unique violation (drizzle wraps the driver error as `cause`). */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** A below-minimum runner past its upgrade grace is refused. */
function assertUpToDate(deps: RunnerDeps, runner: RunnerRow): void {
  if (updateGraceExpired(runner, deps.now())) {
    throw new RunnerRouteError('RUNNER_UPDATE_REQUIRED', `Pipeline runner "${runner.label}" runs an unsupported version (${runner.version}); update it with pipeline-manager infra setup-runner.`, { runnerLabel: runner.label });
  }
}

/**
 * Record + enqueue one start/stop for a runner. A START while another start of
 * the same pipeline is still pending returns that one (no second run); then the
 * org's pending cap and the per-(org, pipeline) rate limit apply.
 */
export async function enqueueRun(deps: RunnerDeps, runner: RunnerRow, input: RouteInput, parentRequestId?: string): Promise<QueuedRun> {
  const reuse = async (): Promise<QueuedRun | null> => {
    const existing = await deps.store.findPendingStart(input.orgId, input.pipelineId);
    if (!existing) return null;
    const via = existing.runnerId === runner.id ? runner : (existing.runnerId ? await deps.store.getRunner(existing.runnerId) : null) ?? runner;
    return { requestId: existing.id, status: existing.status === 'delivering' ? 'delivering' : 'queued', runnerLabel: via.label, runnerId: via.id, reused: true };
  };
  if (input.action === 'start') {
    const existing = await reuse();
    if (existing) return existing;
  }
  assertUpToDate(deps, runner);
  if ((await deps.store.countPending(input.orgId)) >= MAX_PENDING_PER_ORG) {
    throw new RunnerRouteError('TOO_MANY_PENDING', `Your organization already has ${MAX_PENDING_PER_ORG} runs waiting for a runner; wait for some to finish.`, { runnerLabel: runner.label });
  }
  const allowed = await deps.limiter.hit(`${input.orgId}:${input.pipelineId.toLowerCase()}`, RUN_REQUESTS_PER_MINUTE, 60_000);
  if (!allowed) throw new RunnerRouteError('RUN_REQUEST_RATE_LIMITED', 'Too many runs requested for this pipeline; wait a minute and try again.', { runnerLabel: runner.label });
  let row: RunRequestRow;
  try {
    row = await deps.store.insertRequest({
      id: deps.newId(),
      orgId: input.orgId,
      pipelineId: input.pipelineId,
      action: input.action,
      executionId: input.executionId ?? null,
      parentRequestId: parentRequestId ?? null,
      requestedBy: input.requestedBy,
      requestedAt: new Date(deps.now()),
      expiresAt: new Date(deps.now() + RUN_REQUEST_TTL_MS),
      status: 'queued',
      runnerId: runner.id,
    });
  } catch (err) {
    // The one-pending-start index: a concurrent Re-run inserted first — return its request.
    const winner = input.action === 'start' && isUniqueViolation(err) ? await reuse() : null;
    if (winner) return winner;
    throw err;
  }
  deps.metrics.inc('pipeline_runner_requests_total', { status: 'queued' });
  // The row is the durable state: a queue that is down (Redis unavailable)
  // leaves it `queued`, and the sweep enqueues it once the queue is back.
  await deps.queue.enqueue(row.id).catch((err: unknown) => {
    logger.warn('Runner dispatch enqueue failed; the sweep re-kicks the request', { requestId: row.id, error: errorMessage(err) });
  });
  return { requestId: row.id, status: 'queued', runnerLabel: runner.label, runnerId: runner.id, reused: false };
}

/** The linked runner when it is eligible — refused if unhealthy — else null. */
export async function linkedRunner(deps: RunnerDeps, link: RegistryLink | null, eligible: EligibleRunner[]): Promise<RunnerRow | null> {
  if (!link?.runnerId) return null;
  const runner = await deps.store.getRunner(link.runnerId);
  if (!isEligible(runner, eligible)) return null;
  if (runner.health !== 'healthy') throw unhealthy(runner);
  return runner;
}

/**
 * Discovery: probe every eligible runner in parallel for the pipeline's tag.
 * Exactly one match → the pipeline is linked to it (when it has a registry
 * row) and returned. The probes are recorded as `probe` rows so the trail shows
 * which runners were asked.
 */
export async function discoverRunner(
  deps: RunnerDeps, input: RouteInput, eligible: EligibleRunner[], link: RegistryLink | null, parentRequestId?: string,
): Promise<RunnerRow> {
  if (eligible.length === 0) throw new RunnerRouteError('NO_RUNNER', 'This pipeline is not in the platform\'s AWS account and your organization has no pipeline runner to reach it.');
  const healthy = eligible.filter((e) => e.runner.health === 'healthy').map((e) => e.runner);
  const labels = eligible.map((e) => e.runner.label);
  if (healthy.length === 0) throw unhealthy(eligible[0]!.runner);

  const results = await Promise.all(healthy.map(async (runner) => {
    const probe: RunRequestRow = await deps.store.insertRequest({
      id: deps.newId(),
      orgId: input.orgId,
      pipelineId: input.pipelineId,
      action: 'probe',
      requestedBy: input.requestedBy,
      requestedAt: new Date(deps.now()),
      expiresAt: new Date(deps.now() + RUN_REQUEST_TTL_MS),
      status: 'delivering',
      attempts: 1,
      runnerId: runner.id,
      ...(parentRequestId ? { parentRequestId } : {}),
    });
    const hint = link?.region ? { region: link.region, pipelineName: link.pipelineName } : undefined;
    const verdict = await deliverPush(deps, runner, {
      runnerId: runner.id,
      requestId: probe.id,
      action: 'probe',
      pipelineId: input.pipelineId,
      ...(hint ? { hint } : {}),
      requestedBy: input.requestedBy,
      expiresAt: probe.expiresAt,
    });
    const matched = verdict.kind === 'success' && verdict.outcome === 'match';
    if (verdict.kind === 'success') await recordRunnerSuccess(deps, runner, verdict);
    else if (verdict.kind === 'retry' && verdict.transport) await recordRunnerFailure(deps, runner);
    await deps.store.updateRequest(probe.id, matched
      ? { status: 'started' }
      : { status: 'failed', errorCode: verdict.kind === 'fail' ? verdict.code : verdict.kind === 'success' ? 'NO_MATCH' : 'RUNNER_UNREACHABLE' });
    return { runner, matched, ambiguous: verdict.kind === 'fail' && verdict.code === 'AMBIGUOUS_PIPELINE' };
  }));

  const matches = results.filter((r) => r.matched).map((r) => r.runner);
  // A runner that sees MORE than one pipeline carrying this id cannot pick one.
  const ambiguous = results.filter((r) => r.ambiguous).map((r) => r.runner);
  if (ambiguous.length > 0) {
    throw new RunnerRouteError('AMBIGUOUS_PIPELINE', 'A pipeline runner found more than one pipeline tagged with this pipeline\'s id; remove the duplicate tag in that AWS account.', { runnersChecked: ambiguous.map((r) => r.label) });
  }
  if (matches.length > 1) {
    throw new RunnerRouteError('AMBIGUOUS_RUNNER', 'More than one pipeline runner found this pipeline; revoke the runner that should not run it.', { runnersChecked: matches.map((m) => m.label) });
  }
  if (matches.length === 0) {
    throw new RunnerRouteError('PIPELINE_NOT_FOUND_IN_RUNNERS', 'No pipeline runner found this pipeline (by its pb.pipeline-id tag).', { runnersChecked: labels });
  }
  const runner = matches[0]!;
  // A single match IS the verification: link it (a pipeline without a registry row stays unlinked).
  if (link) await deps.store.setRegistryRunner(input.pipelineId, input.orgId, runner.id);
  return runner;
}

/**
 * A linked runner answered PIPELINE_NOT_FOUND for a queued start/stop: the link
 * was already cleared; probe the org's OTHER eligible runners once (the probes
 * name the request as their parent, which is what makes it "once") and, on a
 * single match, re-target the SAME request — the caller keeps polling one id.
 * The dispatch job that asked delivers it again (nothing is enqueued here).
 */
export async function rediscoverRequest(deps: RunnerDeps, request: RunRequestRow, failed: RunnerRow): Promise<boolean> {
  if (await deps.store.hasChildRequests(request.id)) return false;
  const eligible = (await eligibleRunners(deps, request.orgId)).filter((e) => e.runner.id !== failed.id);
  if (eligible.length === 0) return false;
  const link = await deps.store.getRegistryLink(request.pipelineId, request.orgId);
  const input: RouteInput = {
    pipelineId: request.pipelineId,
    orgId: request.orgId,
    requestedBy: request.requestedBy,
    action: request.action === 'stop' ? 'stop' : 'start',
    ...(request.executionId ? { executionId: request.executionId } : {}),
  };
  let runner: RunnerRow;
  try {
    runner = await discoverRunner(deps, input, eligible, link, request.id);
  } catch {
    return false;
  }
  const moved = await deps.store.updateRequest(request.id, {
    runnerId: runner.id, status: 'queued', nextAttemptAt: null, lastDeliveryError: 'rediscovered',
  }, ['queued', 'delivering']);
  return !!moved;
}
