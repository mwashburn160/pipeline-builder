// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Running approved publish requests.
 *
 * A decision (a manager's approval, a second approval, an automatic approval)
 * CLAIMS a request by moving it to `approved`, and records here how it was
 * decided. The execution itself runs as its own task, not as part of the HTTP
 * request that made the decision: publishing a large image into `public/*`
 * takes minutes, and every service answers a request 503 after 25 seconds.
 *
 *  - The deciding request waits up to {@link INLINE_BUDGET_MS} for it. Nearly
 *    every execution finishes inside that, and then behaves exactly as an
 *    inline one: the caller gets the result, or the refusal as an error.
 *  - A slower one carries on in the background; the caller is told it is
 *    publishing, and the request stays `approved` until it completes.
 *  - A TRANSIENT failure (image-registry unreachable, a timeout, a 5xx, a
 *    database blip) keeps the claim and is retried with backoff by
 *    {@link runDueExecutions}. Keeping the claim is what keeps the decision:
 *    an automatic approval under the one-time bootstrap exception is not lost
 *    because image-registry was slow.
 *  - A REFUSAL (a failed check, a conflict, a missing image) rolls the claim
 *    back, as before, and records why on the request for the next decider.
 *  - A transient failure that persists for {@link GIVE_UP_AFTER_MS} is treated
 *    as a refusal, so nothing retries forever.
 *
 * One execution per request at a time, across replicas: each holds a Redis
 * lock on its request id that heartbeats while it runs. The lock's TTL is only
 * how long a crashed pod blocks the request; the retry sweep then picks it up.
 */

import { actorId, AppError, createLogger, createScheduler, DEFAULT_LEADER_LOCK_TTL_MS, ErrorCode, errorMessage, leaderLockKey, SYSTEM_ACTOR_ID, withLeaderLock, type LockRedis, type Scheduler } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { type PluginPublishRequest, type PluginPublishRequestInsert, type Publisher } from '@pipeline-builder/pipeline-data';

import { ecosystemAudit } from './audit.js';
import { countBootstrapApproval } from './bootstrap.js';
import { EcosystemError } from './context.js';
import { execute } from './execute.js';
import { notifyDecision, titleOfRequest } from './notify.js';
import { RegistryPublicationError } from './registry.js';
import { onRemediationRequestPublished } from './remediation-fixes.js';
import { publishers, requests } from './store.js';
import { getHealthRedisConnection } from '../../queue/connections.js';

const logger = createLogger('ecosystem-execution');

type Req = PluginPublishRequest;

/** How long the deciding HTTP request waits before answering "publishing". Under the services' 25s request timeout. */
export const INLINE_BUDGET_MS = 20_000;

/** A transient failure that persists this long is given up on and handed back. */
export const GIVE_UP_AFTER_MS = 24 * 3_600_000;

/** First retry delay; doubles per attempt up to {@link MAX_RETRY_DELAY_MS}. */
const FIRST_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

/** A request the sweep finds with no recorded attempt is left this long first, so the deciding request runs it. */
const SWEEP_MIN_AGE_MS = 60_000;

/** The per-request lock's TTL; it heartbeats while an execution runs. */
const EXECUTION_LOCK_TTL_MS = 60_000;

/** Counter: executions that did not complete, by `kind` and `outcome` (`retrying` | `refused` | `gave_up`). */
export const EXECUTION_FAILED_COUNTER = 'ecosystem_execution_failed_total';

/** How a claim was decided, which decides the follow-up once it executes and the roll-back when it can't. */
export type ExecutionFlavor = 'auto' | 'approve' | 'second-approve';

/** Recorded in `payload.execution` with the claim. */
export interface ExecutionState {
  flavor: ExecutionFlavor;
  /** The decider, as recorded on the audit trail. */
  actor: string;
  /** The decider's note (an approval's note, a second approval's note). */
  note?: string | null;
  /** `reason` before the decision overwrote it with the note; restored on a roll-back. */
  priorReason?: string | null;
  /** An automatic approval's rule name, for the approvals counter. */
  ruleName?: string | null;
  attempts: number;
  lastError?: string | null;
  nextAttemptAt?: string | null;
}

/** What one run of a request's execution came to. */
export type ExecutionOutcome =
  | { status: 'executed' }
  | { status: 'retrying'; error: unknown }
  | { status: 'refused'; error: unknown }
  | { status: 'busy' };

const payloadOf = (r: Req) => (r.payload ?? {}) as Record<string, unknown>;

/** The claim's recorded state (an approved request always has one; a default guards a hand-written row). */
export function executionStateOf(r: Req): ExecutionState {
  const s = payloadOf(r).execution as ExecutionState | undefined;
  return s ?? { flavor: 'approve', actor: r.decidedBy ? actorId({ userId: r.decidedBy }) : SYSTEM_ACTOR_ID, attempts: 0 };
}

/** The payload a claim is written with: the request's own, plus the execution state, minus a previous attempt's error. */
export function claimPayload(r: Req, state: Omit<ExecutionState, 'attempts'>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { executionError: _previous, ...rest } = payloadOf(r);
  return { ...rest, ...extra, execution: { ...state, attempts: 0 } };
}

/**
 * Whether a failure is worth retrying with the claim kept. A refusal is a
 * decision the request can't be executed as it stands — retrying it changes
 * nothing — so only what may succeed later counts as transient.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof RegistryPublicationError) return err.status === 0 || err.status >= 500;
  if (err instanceof AppError) return err.statusCode >= 500;
  // A unique violation is a row that already exists: running again can't help.
  if ((err as { code?: unknown } | null)?.code === '23505') return false;
  return true;
}

/** The roll-back for a claim that will not execute: back to the status it was decided from. */
function rollbackFor(r: Req, state: ExecutionState, error: string): Partial<PluginPublishRequestInsert> {
  const { execution: _state, bootstrap: _bootstrap, ...payload } = payloadOf(r);
  const recorded = { ...payload, executionError: error.slice(0, 500) };
  if (state.flavor === 'auto') {
    return { status: 'pending', decidedBy: null, decidedAt: null, autoRuleId: null, payload: recorded };
  }
  if (state.flavor === 'second-approve') {
    return { status: 'pending_second_approval', secondApprovedBy: null, decidedBy: null, decidedAt: null, payload: recorded };
  }
  return { status: 'pending', decidedBy: null, decidedAt: null, reason: state.priorReason ?? null, payload: recorded };
}

/** Delay before retry number `attempt` (1-based). */
function retryDelayMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, FIRST_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

/** What a completed execution owes: the executed mark, the audit entry, the notice. */
async function finalize(r: Req, publisher: Publisher, state: ExecutionState): Promise<void> {
  // A failed mark must not undo an execution that ran; without it the retry
  // sweep would run it again, so the failure is logged loudly.
  await requests.markExecuted(r.id).catch((err) =>
    logger.error('Recording a request as executed failed; the retry sweep may run it again', { requestId: r.id, error: errorMessage(err) }));
  const title = await titleOfRequest(r, publisher);
  const ref = { ...(r.version ? { version: r.version } : {}), ...(r.digest ? { digest: r.digest } : {}) };
  if (state.flavor === 'auto') {
    const bootstrap = payloadOf(r).bootstrap === true;
    if (bootstrap) await countBootstrapApproval();
    incCounter('ecosystem_auto_approvals_total', { kind: r.kind, rule: bootstrap ? 'bootstrap' : (state.ruleName ?? 'unknown') });
    ecosystemAudit({
      action: 'plugin.request.auto-approve',
      actor: SYSTEM_ACTOR_ID,
      affectedOrgId: publisher.ownerOrgId,
      targetType: 'plugin-publish-request',
      targetId: r.id,
      details: { kind: r.kind, ...(bootstrap ? { bootstrap: true } : { autoRuleId: r.autoRuleId, rule: state.ruleName ?? null }), ...ref },
    });
    await notifyDecision({ kind: r.kind, title, publisherOrgId: publisher.ownerOrgId, approved: true, auto: true });
    return;
  }
  if (state.flavor === 'second-approve') {
    ecosystemAudit({
      action: 'plugin.request.second-approve',
      actor: state.actor,
      affectedOrgId: publisher.ownerOrgId,
      targetType: 'plugin-publish-request',
      targetId: r.id,
      details: { kind: r.kind, firstApprovedBy: r.firstApprovedBy, ...(state.note ? { note: state.note.slice(0, 200) } : {}) },
    });
  } else {
    ecosystemAudit({ action: 'plugin.request.approve', actor: state.actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-publish-request', targetId: r.id, details: { kind: r.kind, ...ref } });
  }
  await notifyDecision({ kind: r.kind, title, publisherOrgId: publisher.ownerOrgId, approved: true, reason: state.note ?? null });
}

/** Run one claimed request's execution, without the lock. */
async function runClaimed(id: string, now: () => Date): Promise<ExecutionOutcome> {
  const r = await requests.byId(id);
  // Executed meanwhile, or no longer approved (rolled back, decided again): nothing to run.
  if (r?.executedAt) return { status: 'executed' };
  if (!r || r.status !== 'approved') return { status: 'busy' };
  const state = executionStateOf(r);
  const publisher = await publishers.byId(r.publisherId);
  try {
    if (!publisher) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Publisher not found');
    await execute(r, publisher, state.actor, { human: state.flavor !== 'auto' });
  } catch (err) {
    const message = errorMessage(err);
    const decidedAt = r.decidedAt ? new Date(r.decidedAt).getTime() : now().getTime();
    const givingUp = now().getTime() - decidedAt >= GIVE_UP_AFTER_MS;
    if (isTransient(err) && !givingUp) {
      const attempts = state.attempts + 1;
      const next = new Date(now().getTime() + retryDelayMs(attempts));
      await requests.transition(r.id, 'approved', {
        payload: { ...payloadOf(r), execution: { ...state, attempts, lastError: message.slice(0, 500), nextAttemptAt: next.toISOString() } },
      });
      incCounter(EXECUTION_FAILED_COUNTER, { kind: r.kind, outcome: 'retrying' });
      logger.warn('Executing an approved request failed; retrying with the approval kept', { requestId: r.id, kind: r.kind, attempts, nextAttemptAt: next.toISOString(), error: message });
      return { status: 'retrying', error: err };
    }
    // A quota refusal already recorded the request as rejected; leave it.
    const current = await requests.byId(r.id);
    if (current?.status === 'approved') await requests.transition(r.id, 'approved', rollbackFor(r, state, message));
    incCounter(EXECUTION_FAILED_COUNTER, { kind: r.kind, outcome: givingUp ? 'gave_up' : 'refused' });
    logger.warn(givingUp ? 'Gave up executing an approved request; handed back for a decision' : 'An approved request could not be executed; handed back for a decision', {
      requestId: r.id, kind: r.kind, flavor: state.flavor, error: message,
    });
    return { status: 'refused', error: err };
  }
  await finalize(r, publisher, state);
  // A remediation's request published its listing version (an automatic or a
  // manager's approval alike): start the Official fix's rollout. Never throws.
  await onRemediationRequestPublished(r);
  return { status: 'executed' };
}

// -----------------------------------------------------------------------------
// Locking (test hooks)
// -----------------------------------------------------------------------------

let lockRedis: (() => LockRedis) | null = getHealthRedisConnection;
let clock: () => Date = () => new Date();

/** Test hook: the per-request lock's Redis (null runs without one). */
export function setExecutionLockForTests(redis: (() => LockRedis) | null | undefined): void {
  lockRedis = redis === undefined ? getHealthRedisConnection : redis;
}

let inlineBudgetMs = INLINE_BUDGET_MS;

/** Test hook: how long the deciding request waits (pass nothing to restore {@link INLINE_BUDGET_MS}). */
export function setInlineBudgetForTests(ms?: number): void {
  inlineBudgetMs = ms ?? INLINE_BUDGET_MS;
}

/** Test hook: the clock the retry schedule reads. */
export function setExecutionClockForTests(fn?: () => Date): void {
  clock = fn ?? (() => new Date());
}

/** Run a request's execution holding its lock; `busy` when another run holds it. */
export async function runExecution(id: string): Promise<ExecutionOutcome> {
  if (!lockRedis) return runClaimed(id, clock);
  let outcome: ExecutionOutcome = { status: 'busy' };
  const ran = await withLeaderLock(lockRedis(), leaderLockKey('plugin', `ecosystem-execute:${id}`), EXECUTION_LOCK_TTL_MS, async () => {
    outcome = await runClaimed(id, clock);
  }, { metricKey: leaderLockKey('plugin', 'ecosystem-execute') });
  return ran ? outcome : { status: 'busy' };
}

/** What the deciding request is told. */
export type InlineResult =
  | { executed: true }
  | { executed: false; reason: 'publishing' | 'retrying'; error?: string };

/**
 * Run a just-claimed request, waiting up to {@link INLINE_BUDGET_MS}. A
 * refusal is thrown, exactly as an inline execution's was; anything still
 * running or being retried is reported, not awaited.
 */
export async function executeClaimNow(id: string): Promise<InlineResult> {
  const run = runExecution(id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<'budget'>((resolve) => {
    timer = setTimeout(() => resolve('budget'), inlineBudgetMs);
    timer.unref?.();
  });
  // The run outlives the budget on purpose; its own failures are recorded on the request.
  run.catch((err) => logger.error('A background execution failed outside its own handling', { requestId: id, error: errorMessage(err) }));
  const first = await Promise.race([run, budget]).finally(() => clearTimeout(timer));
  if (first === 'budget' || first.status === 'busy') return { executed: false, reason: 'publishing' };
  if (first.status === 'executed') return { executed: true };
  if (first.status === 'retrying') return { executed: false, reason: 'retrying', error: errorMessage(first.error) };
  throw first.error;
}

/**
 * The retry sweep: every approved, unexecuted request that is due — a retry
 * whose time has come, or a claim no run has touched (its pod died before it
 * started). Each runs under its own lock, so a run still in progress
 * elsewhere is skipped. Returns how many it ran and how many completed.
 */
export async function runDueExecutions(signal?: AbortSignal): Promise<{ ran: number; executed: number }> {
  const now = clock().getTime();
  let ran = 0;
  let executed = 0;
  for (const r of await requests.unexecutedApprovedBefore(new Date(now))) {
    if (signal?.aborted) break;
    const state = executionStateOf(r);
    const due = state.nextAttemptAt
      ? new Date(state.nextAttemptAt).getTime() <= now
      : (r.decidedAt ? new Date(r.decidedAt).getTime() : 0) <= now - SWEEP_MIN_AGE_MS;
    if (!due) continue;
    const outcome = await runExecution(r.id).catch((err): ExecutionOutcome => {
      logger.warn('Retrying an approved request failed outside its own handling', { requestId: r.id, error: errorMessage(err) });
      return { status: 'busy' };
    });
    if (outcome.status === 'busy') continue;
    ran++;
    if (outcome.status === 'executed') executed++;
  }
  return { ran, executed };
}

/** Build (not start) the retry sweep: every 30 seconds, leader-locked on the shared Redis. */
export function createEcosystemExecutionScheduler(redis: () => LockRedis): Scheduler {
  return createScheduler({
    name: 'ecosystem-execution',
    intervalMs: 30_000,
    startupDelayMs: 30_000,
    lock: { redis, key: leaderLockKey('plugin', 'ecosystem-execution'), ttlMs: DEFAULT_LEADER_LOCK_TTL_MS },
    run: async (lease?: { signal?: AbortSignal }) => {
      const { ran, executed } = await runDueExecutions(lease?.signal);
      if (ran > 0) logger.info('Retried approved requests', { ran, executed });
    },
  });
}
