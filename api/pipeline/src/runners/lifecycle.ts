// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The run request lifecycle after it is queued: push delivery (one attempt per
 * dispatch job, retried on the documented schedule until the request expires),
 * terminal bookkeeping (status, metrics, audit, the registry link), runner
 * health and the periodic sweep.
 *
 * Health: with one runner per AWS account per org and no failover, a broken
 * runner stops every pipeline in that account, so detection is fast. The sweep
 * sends a signed ping to EVERY active runner each
 * RUNNER_HEALTH_PING_INTERVAL_SECONDS; RUNNER_UNHEALTHY_AFTER_PINGS failed pings
 * in a row mark it unreachable, and a SIGNATURE_INVALID or RUNNER_REFUSED reply
 * does at once (a key or configuration problem, not a blip). Delivery transport
 * failures count too (UNREACHABLE_AFTER_FAILURES in a row). Unreachable pauses
 * its deliveries and notices the owning org's admins and the admins of teams
 * using it; a later pong recovers it, says so, and resumes the queued runs.
 *
 * The sweep (leader-locked by the scheduler) also expires requests, keeps
 * retention, re-kicks queued requests, advances the signing-key lifecycle
 * (promote, retire, transitions, age reminders) and publishes the unhealthy gauge.
 */

import { createLogger, errorMessage, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import { RUNNER_API_ERROR_CODES, type RunnerReplyErrorCode, type TerminalRunRequestStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { deliverPush, verdictCode, type ReplyVerdict } from './delivery.js';
import type { RunnerDeps } from './deps.js';
import { advanceKeyTransitions, promoteDueKeys, retireDueKeys, sendKeyAgeReminders } from './keys.js';
import type { RunRequestRow, RunnerRow } from './store.js';
import {
  backoffMs, isSystemRequester, NO_MATCH, PENDING_RUNNER_TTL_MS, PENDING_STATUSES, TERMINAL_STATUSES, NOT_YET_VISIBLE_RETRY_MS,
  NOT_YET_VISIBLE_WINDOW_MS, RUN_REQUEST_EXPIRED, RUNNER_NOT_ELIGIBLE, runnerSettings, SYSTEM_PLUGIN_UPGRADE, SYSTEM_RUNNER_PING, UNREACHABLE_AFTER_FAILURES,
  versionBelow,
} from './vocabulary.js';

const logger = createLogger('runner-dispatch');

/** How long one delivery may hold a pipeline's lock (delivery timeout + margin). */
const LOCK_TTL_MS = 30_000;
/** A job that found the pipeline busy tries again this soon. */
const BUSY_RETRY_MS = 1_000;

/** What the dispatch job should do next. */
export type DispatchResult = { done: true } | { done: false; retryInMs: number };

const actorOf = (requestedBy: string): string => (isSystemRequester(requestedBy) ? SYSTEM_ACTOR_ID : requestedBy);

/** The platform's own refusals (paused, no key, an unreadable key): not the runner's fault, never counted. */
export const PLATFORM_SIDE: ReadonlySet<string> = new Set<string>(RUNNER_API_ERROR_CODES);

/** Codes that mean the linked pipeline is not (or no longer) the one this runner can see. */
const CLEARS_LINK = new Set<string>(['PIPELINE_IDENTITY_MISMATCH', 'PIPELINE_NOT_TAGGED'] satisfies RunnerReplyErrorCode[]);

/**
 * Move a request to a terminal status (only from a pending one — a late
 * duplicate can't overwrite the outcome), then count, audit and link.
 */
export async function finishRequest(
  deps: RunnerDeps,
  request: RunRequestRow,
  status: TerminalRunRequestStatus,
  extra: { executionId?: string; errorCode?: string } = {},
): Promise<RunRequestRow | null> {
  // A start/stop the runner accepted records WHEN, so the Delivery report can
  // measure requested → accepted exactly instead of estimating it.
  const accepted = (request.action === 'start' && status === 'started') || (request.action === 'stop' && status === 'stopped');
  const row = await deps.store.updateRequest(request.id, {
    status,
    resultExecutionId: extra.executionId ?? null,
    errorCode: extra.errorCode ?? null,
    nextAttemptAt: null,
    ...(accepted ? { acceptedAt: new Date(deps.now()) } : {}),
  }, PENDING_STATUSES);
  if (!row) return null;
  deps.metrics.inc('pipeline_runner_requests_total', { status });

  if (row.action === 'start' || row.action === 'stop') {
    const succeeded = status === 'started' || status === 'stopped';
    deps.audit({
      action: row.action === 'start' ? 'pipeline.execution.start' : 'pipeline.execution.cancel',
      actorId: actorOf(row.requestedBy),
      orgId: row.orgId,
      targetType: 'pipeline_execution',
      ...(extra.executionId ?? row.executionId ? { targetId: extra.executionId ?? row.executionId ?? undefined } : {}),
      ...(succeeded ? {} : { outcome: 'failure' as const }),
      details: {
        pipelineId: row.pipelineId,
        requestId: row.id,
        runnerId: row.runnerId,
        attempts: row.attempts,
        outcome: status,
        ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
        ...(row.requestedBy === SYSTEM_PLUGIN_UPGRADE ? { reason: 'plugin-upgrade' } : {}),
      },
    });
    // A VERIFIED run links the pipeline to the runner that ran it.
    if (succeeded && row.runnerId) await deps.store.setRegistryRunner(row.pipelineId, row.orgId, row.runnerId).catch(() => false);
  }
  if (extra.errorCode && CLEARS_LINK.has(extra.errorCode) && row.runnerId) {
    await deps.store.setRegistryRunner(row.pipelineId, row.orgId, null, row.runnerId).catch(() => false);
  }
  return row;
}

/** Apply a runner verdict to a request. Returns the retry delay, if any. */
export async function applyVerdict(deps: RunnerDeps, request: RunRequestRow, runner: RunnerRow, verdict: ReplyVerdict): Promise<DispatchResult> {
  const now = deps.now();
  if (verdict.kind === 'success') {
    await recordRunnerSuccess(deps, runner, verdict);
    if (request.action === 'probe') {
      if (verdict.outcome === 'match') await finishRequest(deps, request, 'started');
      else await finishRequest(deps, request, 'failed', { errorCode: NO_MATCH });
    } else {
      await finishRequest(deps, request, request.action === 'start' ? 'started' : 'stopped', { ...(verdict.executionId ? { executionId: verdict.executionId } : {}) });
    }
    return { done: true };
  }
  if (verdict.kind === 'fail' && PLATFORM_SIDE.has(verdict.code)) {
    // The platform refused before anything was sent (never the runner's doing:
    // its health is untouched). Paused mid-job: the request stays queued and the
    // sweep re-kicks it on resume. The org's key missing or unreadable: fail closed.
    if (verdict.code === 'RUNNERS_UNAVAILABLE') {
      await deps.store.updateRequest(request.id, { status: 'queued', lastDeliveryError: verdict.code, nextAttemptAt: null }, PENDING_STATUSES);
      return { done: true };
    }
    await finishRequest(deps, request, 'failed', { errorCode: verdict.code });
    return { done: true };
  }
  if (verdict.kind === 'fail') {
    // The runner answered: it is reachable, whatever it said.
    await recordRunnerSuccess(deps, runner, verdict.runnerVersion ? { runnerVersion: verdict.runnerVersion } : {});
    // A LINKED runner that no longer finds the pipeline: the link is stale (the
    // pipeline moved accounts). Clear it and re-discover — once. A re-targeted
    // request is delivered again by THIS job: completing it and enqueueing anew
    // would be a no-op in BullMQ (the active job still holds the request's id).
    if (verdict.code === 'PIPELINE_NOT_FOUND' && (request.action === 'start' || request.action === 'stop')) {
      await deps.store.setRegistryRunner(request.pipelineId, request.orgId, null, runner.id).catch(() => false);
      const { rediscoverRequest } = await import('./routing.js');
      if (await rediscoverRequest(deps, request, runner).catch(() => false)) return { done: false, retryInMs: 0 };
    }
    await finishRequest(deps, request, 'failed', { errorCode: verdict.code });
    return { done: true };
  }
  let delay: number;
  let code: string;
  if (verdict.kind === 'not_yet_visible') {
    await recordRunnerSuccess(deps, runner, {});
    const requestedAt = request.requestedAt?.getTime() ?? now;
    if (now + NOT_YET_VISIBLE_RETRY_MS - requestedAt > NOT_YET_VISIBLE_WINDOW_MS) {
      await finishRequest(deps, request, 'failed', { errorCode: 'NOT_YET_VISIBLE' });
      return { done: true };
    }
    delay = NOT_YET_VISIBLE_RETRY_MS;
    code = 'NOT_YET_VISIBLE';
  } else {
    if (verdict.transport) runner = (await recordRunnerFailure(deps, runner, verdict.immediate)) ?? runner;
    delay = backoffMs(Math.max(1, request.attempts));
    code = verdict.code;
  }
  if (now + delay >= request.expiresAt.getTime()) {
    await finishRequest(deps, request, 'expired', { errorCode: RUN_REQUEST_EXPIRED });
    return { done: true };
  }
  await deps.store.updateRequest(request.id, {
    status: 'queued', lastDeliveryError: code, nextAttemptAt: new Date(now + delay),
  }, PENDING_STATUSES);
  // A runner that just went unreachable is PAUSED: its requests wait for the resume.
  if (runner.health !== 'healthy') return { done: true };
  return { done: false, retryInMs: delay };
}

// -- Health ---------------------------------------------------------------------

/** A reachable runner: reset failures, stamp delivery, learn its version; recover if unhealthy. */
export async function recordRunnerSuccess(deps: RunnerDeps, runner: RunnerRow, info: { runnerVersion?: string; regions?: string[] }): Promise<void> {
  const now = new Date(deps.now());
  const wasUnhealthy = runner.health !== 'healthy';
  const version = versionPatch(runner, info.runnerVersion, now);
  await deps.store.updateRunner(runner.id, {
    consecutiveFailures: 0,
    lastDeliveryAt: now,
    health: 'healthy',
    ...(info.runnerVersion ? { version: info.runnerVersion } : {}),
    ...(info.regions ? { regions: info.regions } : {}),
    ...version.patch,
  });
  // Once: the flag's timestamp is set only on the transition.
  if (version.flagged) await notifyUpdateRequired(deps, runner, info.runnerVersion!);
  if (wasUnhealthy) {
    healthAudit(deps, runner, 'healthy');
    const resumed = await resumeRunner(deps, runner.id);
    await notifyRunnerOrgs(deps, runner, {
      subject: `Pipeline runner "${runner.label}" is reachable again`,
      content: `The pipeline runner "${runner.label}" answered the platform again. Runs through it have resumed${resumed > 0 ? ` (${resumed} queued run${resumed === 1 ? '' : 's'} picked up)` : ''}.`,
      priority: 'normal',
    });
  }
}

/**
 * The MIN_RUNNER_VERSION bookkeeping for a reported version: start the grace
 * clock (and say so, once) when it first falls below the minimum; clear it
 * once the runner reports a version at or above it.
 */
export function versionPatch(runner: Pick<RunnerRow, 'updateRequiredSince'>, reported: string | undefined, now: Date): { patch: Partial<RunnerRow>; flagged: boolean } {
  if (!reported) return { patch: {}, flagged: false };
  const below = versionBelow(reported, runnerSettings().minRunnerVersion);
  if (below && !runner.updateRequiredSince) return { patch: { updateRequiredSince: now }, flagged: true };
  if (!below && runner.updateRequiredSince) return { patch: { updateRequiredSince: null }, flagged: false };
  return { patch: {}, flagged: false };
}

/** Tell the org's inbox a runner fell below MIN_RUNNER_VERSION (sent on the transition only). */
export async function notifyUpdateRequired(deps: RunnerDeps, runner: Pick<RunnerRow, 'orgId' | 'label'>, version: string): Promise<void> {
  await deps.notify({
    recipientOrgId: runner.orgId,
    subject: `Pipeline runner "${runner.label}" needs an update`,
    content: `The pipeline runner "${runner.label}" reports version ${version}, below the minimum this platform supports (${runnerSettings().minRunnerVersion}). Re-run \`pipeline-manager infra setup-runner\` to update it; after ${runnerSettings().upgradeGraceDays} days runs through it will be refused.`,
    priority: 'normal',
  }).catch(() => false);
}

/** Whether a below-minimum runner's grace period is over (new requests to it are refused). */
export function updateGraceExpired(runner: RunnerRow, now: number): boolean {
  if (!runner.updateRequiredSince) return false;
  if (!versionBelow(runner.version, runnerSettings().minRunnerVersion)) return false;
  return now - runner.updateRequiredSince.getTime() > runnerSettings().upgradeGraceDays * 24 * 60 * 60_000;
}

/**
 * A transport failure: count it; the UNREACHABLE_AFTER_FAILURES-th consecutive
 * one marks the runner unreachable — and an `immediate` one (NXDOMAIN, AWS's
 * "URL gone" 403) at once.
 */
export async function recordRunnerFailure(deps: RunnerDeps, runner: RunnerRow, immediate = false): Promise<RunnerRow | null> {
  const updated = await deps.store.recordRunnerFailure(runner.id);
  if (!updated) return null;
  if (updated.health === 'healthy' && (immediate || updated.consecutiveFailures >= UNREACHABLE_AFTER_FAILURES)) {
    return (await markUnreachable(deps, updated, `stopped answering deliveries (${updated.consecutiveFailures} failed in a row)`)) ?? { ...updated, health: 'unreachable' as const };
  }
  return updated;
}

/**
 * healthy → unreachable, and the notice. Conditional (WHERE health =
 * 'healthy'): of two failures crossing the threshold together only one takes
 * the transition, so the orgs hear once. Returns the row when THIS call made
 * the transition, else null.
 */
export async function markUnreachable(deps: RunnerDeps, runner: RunnerRow, cause: string): Promise<RunnerRow | null> {
  const updated = await deps.store.markRunnerUnreachable(runner.id);
  if (!updated) return null;
  healthAudit(deps, runner, 'unreachable');
  const every = Math.round(runnerSettings().healthPingIntervalMs / 1000);
  // Never names the URL.
  await notifyRunnerOrgs(deps, runner, {
    subject: `Pipeline runner "${runner.label}" is unreachable`,
    content: `The pipeline runner "${runner.label}" ${cause}. Runs through it are paused; the platform pings it every ${every} seconds and resumes delivery as soon as it answers. Check the runner Lambda in your AWS account, then use "Test" under Settings → Pipeline runners.`,
    priority: 'high',
  });
  return updated;
}

/**
 * An org notice about a runner, to the owning org's admins and — when it is
 * shared with teams — to the admins of every team with a pipeline linked to it
 * (the message service's system notification: inbox, email, webhooks).
 */
async function notifyRunnerOrgs(deps: RunnerDeps, runner: Pick<RunnerRow, 'id' | 'orgId' | 'shareWithTeams'>, notice: { subject: string; content: string; priority: 'high' | 'normal' }): Promise<void> {
  const teams = runner.shareWithTeams ? await deps.store.linkedOrgIds(runner.id, runner.orgId).catch(() => [] as string[]) : [];
  for (const recipientOrgId of [runner.orgId, ...teams]) {
    await deps.notify({ recipientOrgId, ...notice }).catch(() => false);
  }
}

function healthAudit(deps: RunnerDeps, runner: RunnerRow, health: string): void {
  deps.audit({
    action: 'pipeline.runner.health',
    actorId: SYSTEM_ACTOR_ID,
    orgId: runner.orgId,
    targetType: 'pipeline_runner',
    targetId: runner.id,
    details: { from: runner.health, to: health },
  });
}

/** Re-enqueue a recovered runner's paused requests. */
export async function resumeRunner(deps: RunnerDeps, runnerId: string): Promise<number> {
  const queued = await deps.store.listRunnerRequests(runnerId, ['queued']);
  for (const r of queued) await deps.queue.enqueue(r.id);
  return queued.length;
}

// -- Dispatch -------------------------------------------------------------------

/**
 * One dispatch job: deliver the request once (serialized per pipeline), then
 * finish it or say when to retry. Expired requests are never delivered.
 */
export async function processDelivery(deps: RunnerDeps, requestId: string): Promise<DispatchResult> {
  // Checked per job: the platform pause toggle (or lost secret encryption)
  // stops delivery at once. The request stays queued; the sweep re-kicks it
  // once runners are available again, else it expires.
  if (!(await deps.runnersAvailable()).available) return { done: true };
  const request = await deps.store.getRequest(requestId);
  if (!request || TERMINAL_STATUSES.includes(request.status)) return { done: true };
  const now = deps.now();
  if (request.expiresAt.getTime() <= now) {
    await finishRequest(deps, request, 'expired', { errorCode: RUN_REQUEST_EXPIRED });
    return { done: true };
  }
  const runner = request.runnerId ? await deps.store.getRunner(request.runnerId) : null;
  if (!runner || runner.status !== 'active') {
    // The same code a revoke records on the requests it expires itself.
    await finishRequest(deps, request, 'expired', { errorCode: runner?.status === 'revoked' ? 'RUNNER_REVOKED' : RUN_REQUEST_EXPIRED });
    return { done: true };
  }
  if (runner.health !== 'healthy') return { done: true }; // paused until resume
  if (request.nextAttemptAt && request.nextAttemptAt.getTime() > now) return { done: false, retryInMs: request.nextAttemptAt.getTime() - now };

  // Still a runner this org may use? (An ancestor's runner may have been
  // un-shared, or the team moved, since the request was routed.) Never sent
  // otherwise; an ancestry lookup that fails is retried, never a failure.
  let eligible: boolean;
  try {
    const { stillEligible } = await import('./routing.js');
    eligible = await stillEligible(deps, request.orgId, runner);
  } catch (err) {
    logger.warn('Runner eligibility could not be re-checked; delivery retried', { requestId: request.id, error: errorMessage(err) });
    return { done: false, retryInMs: backoffMs(Math.max(1, request.attempts)) };
  }
  if (!eligible) {
    await deps.store.setRegistryRunner(request.pipelineId, request.orgId, null, runner.id).catch(() => false);
    await finishRequest(deps, request, 'failed', { errorCode: RUNNER_NOT_ELIGIBLE });
    return { done: true };
  }

  // At most MAX_IN_FLIGHT_PER_RUNNER deliveries to one runner at a time.
  if ((await deps.store.countDelivering(runner.id)) >= runnerSettings().maxInFlightPerRunner) return { done: false, retryInMs: BUSY_RETRY_MS };
  const token = await deps.lock.acquire(request.pipelineId, LOCK_TTL_MS);
  if (!token) return { done: false, retryInMs: BUSY_RETRY_MS };
  try {
    const delivering = await deps.store.updateRequest(request.id, { status: 'delivering', attempts: request.attempts + 1 }, ['queued', 'delivering']);
    if (!delivering) return { done: true };
    const hint = await hintFor(deps, delivering);
    const verdict = await deliverPush(deps, runner, {
      runnerId: runner.id,
      requestId: delivering.id,
      action: delivering.action,
      pipelineId: delivering.pipelineId,
      ...(hint ? { hint } : {}),
      ...(delivering.executionId ? { executionId: delivering.executionId } : {}),
      requestedBy: delivering.requestedBy,
      expiresAt: delivering.expiresAt,
    });
    return await applyVerdict(deps, delivering, runner, verdict);
  } finally {
    await deps.lock.release(request.pipelineId, token);
  }
}

/** The last known location, when the registry has one. */
export async function hintFor(deps: RunnerDeps, request: RunRequestRow): Promise<{ region: string; pipelineName: string } | undefined> {
  const link = await deps.store.getRegistryLink(request.pipelineId, request.orgId).catch(() => null);
  return link && link.region ? { region: link.region, pipelineName: link.pipelineName } : undefined;
}

// -- Sweep --------------------------------------------------------------------

export interface SweepCounts {
  expired: number;
  pinged: number;
  recovered: number;
  markedUnhealthy: number;
  rekicked: number;
  pendingDeleted: number;
  retained: number;
  /** Registry rows left `checking` past {@link STALE_LINK_CHECK_MS}, put back. */
  staleLinkChecks: number;
}

/** A probe takes seconds (one delivery timeout); a row `checking` longer than this lost its probe. */
const STALE_LINK_CHECK_MS = 5 * 60_000;

/** The signing-key lifecycle steps, run by the leader each sweep (each is idempotent). */
const KEY_SWEEPS = [
  ['promoteDueKeys', promoteDueKeys],
  ['retireDueKeys', retireDueKeys],
  ['advanceKeyTransitions', advanceKeyTransitions],
  ['sendKeyAgeReminders', sendKeyAgeReminders],
] as const;

/** The periodic sweep (leader-locked by the scheduler). */
export async function runSweep(deps: RunnerDeps): Promise<SweepCounts> {
  const now = deps.now();
  const counts: SweepCounts = { expired: 0, pinged: 0, recovered: 0, markedUnhealthy: 0, rekicked: 0, pendingDeleted: 0, retained: 0, staleLinkChecks: 0 };
  const settings = runnerSettings();
  const day = 24 * 60 * 60_000;

  // 1. Expiry: a request not delivered within its 10 minutes is never delivered.
  for (const r of await deps.store.listExpired(new Date(now))) {
    if (await finishRequest(deps, r, 'expired', { errorCode: RUN_REQUEST_EXPIRED })) counts.expired++;
  }

  // Housekeeping: registered-but-never-deployed runners, and retention.
  counts.pendingDeleted = await deps.store.deletePendingRunnersBefore(new Date(now - PENDING_RUNNER_TTL_MS));
  counts.retained += await deps.store.deleteRequestsBefore(['started', 'stopped'], new Date(now - settings.retentionDays * day));
  counts.retained += await deps.store.deleteRequestsBefore(['failed', 'expired'], new Date(now - settings.failedRetentionDays * day));
  // A replica that died mid-probe (Find runner again, registration) left its row `checking`.
  counts.staleLinkChecks = await deps.store.resetStaleLinkChecks(new Date(now - STALE_LINK_CHECK_MS));

  // 2. The signing-key lifecycle: promote due `next` keys, retire `retiring`
  // ones past retire_after, advance mode/ancestry transitions, age reminders.
  // Independent of the pause toggle (a rotation keeps its schedule); one step
  // failing never stops the others or the rest of the sweep.
  for (const [name, step] of KEY_SWEEPS) {
    try {
      await step(deps, new Date(now));
    } catch (err) {
      logger.warn('Runner signing-key sweep step failed', { step: name, error: errorMessage(err) });
    }
  }

  // Paused (or no secret encryption): nothing below delivers anything.
  if (!(await deps.runnersAvailable()).available) {
    deps.metrics.gauge(UNHEALTHY_GAUGE, {}, await deps.store.countUnhealthyRunners());
    return counts;
  }

  // 3. Re-kick queued requests whose job may be gone (a lost job, the queue or
  // deliveries back). The queue de-duplicates by request id.
  for (const r of await deps.store.listQueued(200)) {
    if (r.action === 'probe') continue;
    if (r.nextAttemptAt && r.nextAttemptAt.getTime() > now) continue;
    await deps.queue.enqueue(r.id);
    counts.rekicked++;
  }

  // 4. Health: a signed ping to every active runner each interval.
  await healthPings(deps, now, counts);

  deps.metrics.gauge(UNHEALTHY_GAUGE, {}, await deps.store.countUnhealthyRunners());
  if (counts.expired + counts.recovered + counts.markedUnhealthy > 0) logger.info('Runner sweep', { ...counts });
  return counts;
}

/** Per-deps health bookkeeping: when each runner was last pinged, and its failed pings in a row. */
interface HealthState { lastPingAt: Map<string, number>; failedPings: Map<string, number> }
const healthStates = new WeakMap<RunnerDeps, HealthState>();
function healthState(deps: RunnerDeps): HealthState {
  let state = healthStates.get(deps);
  if (!state) healthStates.set(deps, (state = { lastPingAt: new Map(), failedPings: new Map() }));
  return state;
}

/** A ping reply that means a key or configuration problem: unhealthy at once. */
const IMMEDIATELY_UNHEALTHY = new Set<string>(['SIGNATURE_INVALID', 'RUNNER_REFUSED'] satisfies RunnerReplyErrorCode[]);

type PingResult = 'ok' | 'recovered' | 'failed' | 'unhealthy' | 'skipped';

/** Ping every active runner whose last ping is at least an interval old (bounded concurrency). */
async function healthPings(deps: RunnerDeps, now: number, counts: SweepCounts): Promise<void> {
  const { healthPingIntervalMs, unhealthyAfterPings, dispatchConcurrency } = runnerSettings();
  const state = healthState(deps);
  const active = await deps.store.listActiveRunners();
  const live = new Set(active.map((r) => r.id));
  for (const map of [state.lastPingAt, state.failedPings]) for (const id of map.keys()) if (!live.has(id)) map.delete(id);
  const due = active.filter((r) => r.functionUrl && now - (state.lastPingAt.get(r.id) ?? Number.NEGATIVE_INFINITY) >= healthPingIntervalMs);
  for (let i = 0; i < due.length; i += dispatchConcurrency) {
    await Promise.all(due.slice(i, i + dispatchConcurrency).map(async (runner) => {
      state.lastPingAt.set(runner.id, now);
      counts.pinged++;
      const result = await healthPing(deps, runner, unhealthyAfterPings, state);
      if (result === 'recovered') counts.recovered++;
      if (result === 'unhealthy') counts.markedUnhealthy++;
    }));
  }
}

/** One health ping and what it does to the runner's health. */
async function healthPing(deps: RunnerDeps, runner: RunnerRow, unhealthyAfterPings: number, state: HealthState): Promise<PingResult> {
  let verdict: ReplyVerdict;
  try {
    verdict = await deliverPush(deps, runner, { runnerId: runner.id, requestId: deps.newId(), action: 'ping', requestedBy: SYSTEM_RUNNER_PING });
  } catch (err) {
    // The platform could not sign (the org's key is missing or unreadable): not the runner's fault.
    logger.warn('Runner health ping not sent', { runnerId: runner.id, error: errorMessage(err) });
    return 'skipped';
  }
  if (verdict.kind === 'success') {
    state.failedPings.delete(runner.id);
    const wasUnhealthy = runner.health !== 'healthy';
    await recordRunnerSuccess(deps, runner, verdict);
    return wasUnhealthy ? 'recovered' : 'ok';
  }
  const code = verdictCode(verdict) ?? '';
  if (PLATFORM_SIDE.has(code)) return 'skipped';
  if (verdict.kind === 'not_yet_visible' || (verdict.kind === 'retry' && !verdict.transport)) return 'ok'; // it answered
  if (runner.health !== 'healthy') return 'failed'; // still down: keep pinging
  if (verdict.kind === 'fail' && IMMEDIATELY_UNHEALTHY.has(code)) {
    state.failedPings.delete(runner.id);
    const marked = await markUnreachable(deps, runner, `refused the platform's signed health ping (${code}): its signing keys or configuration don't match the platform's`);
    return marked ? 'unhealthy' : 'failed';
  }
  const failed = (state.failedPings.get(runner.id) ?? 0) + 1;
  state.failedPings.set(runner.id, failed);
  if (failed >= unhealthyAfterPings || (verdict.kind === 'retry' && verdict.immediate)) {
    state.failedPings.delete(runner.id);
    const marked = await markUnreachable(deps, runner, `failed ${failed} health ping${failed === 1 ? '' : 's'} in a row (${code})`);
    return marked ? 'unhealthy' : 'failed';
  }
  return 'failed';
}

/**
 * `pipeline_runners_unhealthy` — the fleet-wide count of unreachable runners,
 * published by the replica that ran the leader-locked sweep. Only the CURRENT
 * leader may export it: a replica that lost the lock would otherwise keep its
 * last value forever, and `max()` in RunnerUnreachable would keep firing.
 */
export const UNHEALTHY_GAUGE = 'pipeline_runners_unhealthy';

/** This replica's sweep ran without the lock: stop exporting the count it published as leader. */
export function dropUnhealthyGauge(deps: RunnerDeps): void {
  deps.metrics.resetGauge(UNHEALTHY_GAUGE);
}
