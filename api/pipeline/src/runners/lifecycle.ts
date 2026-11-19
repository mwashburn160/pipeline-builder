// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The run request lifecycle after it is queued: push delivery (one attempt per
 * dispatch job, retried on the documented schedule until the request expires),
 * terminal bookkeeping (status, metrics, audit, the registry link), runner
 * health (unreachable after 5 consecutive transport failures, paused delivery,
 * an org notice, a ping every 5 min, resume on success) and the periodic sweep
 * (expiry, health pings, the unhealthy gauge).
 */

import { createLogger, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import type { RunnerReplyErrorCode, TerminalRunRequestStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { deliverPush, type ReplyVerdict } from './delivery.js';
import type { RunnerDeps } from './deps.js';
import type { RunRequestRow, RunnerRow } from './store.js';
import {
  backoffMs, MAX_IN_FLIGHT_PER_RUNNER, NO_MATCH, PENDING_RUNNER_TTL_MS, PENDING_STATUSES, TERMINAL_STATUSES, NOT_YET_VISIBLE_RETRY_MS,
  NOT_YET_VISIBLE_WINDOW_MS, RUN_REQUEST_EXPIRED, runnerSettings, SYSTEM_PLUGIN_UPGRADE, SYSTEM_RUNNER_PING, UNREACHABLE_AFTER_FAILURES,
  UNREACHABLE_PING_INTERVAL_MS, versionBelow,
} from './vocabulary.js';

const logger = createLogger('runner-dispatch');

/** How long one delivery may hold a pipeline's lock (delivery timeout + margin). */
const LOCK_TTL_MS = 30_000;
/** A job that found the pipeline busy tries again this soon. */
const BUSY_RETRY_MS = 1_000;

/** What the dispatch job should do next. */
export type DispatchResult = { done: true } | { done: false; retryInMs: number };

const actorOf = (requestedBy: string): string => (requestedBy.startsWith('system:') ? SYSTEM_ACTOR_ID : requestedBy);

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
  const row = await deps.store.updateRequest(request.id, {
    status,
    resultExecutionId: extra.executionId ?? null,
    errorCode: extra.errorCode ?? null,
    nextAttemptAt: null,
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
    await resumeRunner(deps, runner.id);
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
 * A transport failure: count it; the 5th consecutive one marks the runner
 * unreachable — and an `immediate` one (NXDOMAIN, AWS's "URL gone" 403) at once.
 */
export async function recordRunnerFailure(deps: RunnerDeps, runner: RunnerRow, immediate = false): Promise<RunnerRow | null> {
  const updated = await deps.store.recordRunnerFailure(runner.id);
  if (!updated) return null;
  if (updated.health === 'healthy' && (immediate || updated.consecutiveFailures >= UNREACHABLE_AFTER_FAILURES)) {
    return markUnreachable(deps, updated);
  }
  return updated;
}

async function markUnreachable(deps: RunnerDeps, runner: RunnerRow): Promise<RunnerRow> {
  // Conditional (WHERE health = 'healthy'): of two failures crossing the
  // threshold together only one takes the transition, so the org hears once.
  const updated = await deps.store.markRunnerUnreachable(runner.id);
  if (!updated) return { ...runner, health: 'unreachable' as const };
  healthAudit(deps, runner, 'unreachable');
  // The org's inbox (the message service's system notification). Never names the URL.
  await deps.notify({
    recipientOrgId: runner.orgId,
    subject: `Pipeline runner "${runner.label}" is unreachable`,
    content: `The pipeline runner "${runner.label}" stopped answering deliveries (${runner.consecutiveFailures} failed in a row). Runs through it are paused; the platform pings it every 5 minutes and resumes delivery as soon as it answers. Check the runner Lambda in your AWS account, then use "Test" under Settings → Organization → Pipeline runners.`,
    priority: 'high',
  }).catch(() => false);
  return updated;
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
  // Checked per job: a lost signing key stops delivery at once. The request
  // stays queued; the sweep re-kicks it if runners come back, else it expires.
  if (!deps.signer()) return { done: true };
  const request = await deps.store.getRequest(requestId);
  if (!request || TERMINAL_STATUSES.includes(request.status)) return { done: true };
  // The org lost the `cross_account_runners` feature since it asked: refused, never delivered.
  if (!(await deps.orgEnabled(request.orgId))) {
    await finishRequest(deps, request, 'failed', { errorCode: 'RUNNERS_NOT_ENABLED' });
    return { done: true };
  }
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

  // At most MAX_IN_FLIGHT_PER_RUNNER deliveries to one runner at a time.
  if ((await deps.store.countDelivering(runner.id)) >= MAX_IN_FLIGHT_PER_RUNNER) return { done: false, retryInMs: BUSY_RETRY_MS };
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

export interface SweepCounts { expired: number; pinged: number; recovered: number; rekicked: number; pendingDeleted: number; retained: number }

/** The periodic sweep (leader-locked by the scheduler). */
export async function runSweep(deps: RunnerDeps): Promise<SweepCounts> {
  const now = deps.now();
  const counts: SweepCounts = { expired: 0, pinged: 0, recovered: 0, rekicked: 0, pendingDeleted: 0, retained: 0 };
  // A database created before runners (postgres-init.sql runs on new installs
  // only) has no runner tables: nothing to sweep, and no error every cycle.
  if (!(await deps.store.tablesPresent())) return counts;
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

  // No signing key: nothing below delivers anything.
  if (!deps.signer()) {
    deps.metrics.gauge('pipeline_runners_unhealthy', {}, await deps.store.countUnhealthyRunners());
    return counts;
  }

  // Re-kick queued requests whose job may be gone (a lost job, the signing key
  // restored). The queue de-duplicates by request id.
  for (const r of await deps.store.listQueued(200)) {
    if (r.action === 'probe') continue;
    if (!(await deps.orgEnabled(r.orgId))) continue; // the job will fail it RUNNERS_NOT_ENABLED; leave it to expire
    if (r.nextAttemptAt && r.nextAttemptAt.getTime() > now) continue;
    await deps.queue.enqueue(r.id);
    counts.rekicked++;
  }

  // 2. Unreachable runners: a signed ping every 5 minutes.
  for (const runner of await deps.store.listActiveRunners()) {
    if (runner.health !== 'unreachable') continue;
    if (!(await deps.orgEnabled(runner.orgId))) continue; // health sweeps skip orgs without the feature
    const last = runner.updatedAt?.getTime() ?? 0;
    if (now - last < UNREACHABLE_PING_INTERVAL_MS) continue;
    counts.pinged++;
    if (await pingRunner(deps, runner, SYSTEM_RUNNER_PING)) counts.recovered++;
    else await deps.store.updateRunner(runner.id, { updatedAt: new Date(now) });
  }

  deps.metrics.gauge('pipeline_runners_unhealthy', {}, await deps.store.countUnhealthyRunners());
  if (counts.expired + counts.recovered > 0) logger.info('Runner sweep', { ...counts });
  return counts;
}

/** A signed ping to a runner. Success marks it healthy (and resumes delivery). */
export async function pingRunner(deps: RunnerDeps, runner: RunnerRow, requestedBy: string): Promise<{ outcome: string } | null> {
  const verdict = await deliverPush(deps, runner, { runnerId: runner.id, requestId: deps.newId(), action: 'ping', requestedBy });
  if (verdict.kind === 'success') {
    await recordRunnerSuccess(deps, runner, verdict);
    return { outcome: verdict.outcome };
  }
  return null;
}
