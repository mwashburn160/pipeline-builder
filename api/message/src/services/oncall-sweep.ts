// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-case on-call trigger: page before a premium case breaches, not after.
 *
 * WHY THIS EXISTS WHEN AN ALERT ALREADY WATCHES THE SAME PROMISE.
 * `SupportPremiumFirstResponseAtRisk` is a p90 over six hours. A p90 can say the
 * distribution has already drifted; it can never say WHICH case is about to
 * breach, and by the time a six-hour window has moved it, the eight-hour target
 * is mostly spent. This sweep reads the exact `response_due_at` the customer was
 * given, so the page names the case and arrives with the lead time still on the
 * clock. That precision is the whole reason the trigger is worth owning
 * product-side while the rota, the escalation and the contact methods are not.
 *
 * WHAT MAKES IT SAFE TO BE STUPID, which is the design's main claim.
 * There is no `paged_at` column, no ledger and no per-tick state. Every tick
 * re-derives the whole set from the table and re-sends `trigger` for each case
 * on the key `case:<id>`, and PagerDuty collapses repeats of a key onto one
 * incident. So:
 *
 *  - a case inside the window is re-sent every tick and stays ONE page;
 *  - fifty cases breaching together — the normal shape after an outage — is
 *    fifty keys, which the provider groups by service; fifty pages and no pages
 *    are the same thing, and this is the one place that distinction is bought
 *    rather than built;
 *  - two replicas running the same tick produce the same keys, so the leader
 *    lock below is an efficiency measure and not a correctness one.
 *
 * That last point decides the Redis question. `createScheduler` with a `lock`
 * runs UNLOCKED on every pod when Redis is not configured, and here that is the
 * behaviour to want: idempotence makes duplicate ticks harmless, while failing
 * closed would mean a Redis outage silently stops the pager. A pager that stops
 * when its cache stops is not a pager. (The dead-man switch in api-core's
 * `alert-delivery` is a separate always-on timer for the same reason — it is
 * deliberately NOT routed through this sweep, so the sweep's dependencies are
 * not also the heartbeat's.)
 *
 * RESOLUTION IS NOT HERE, DELIBERATELY. A trigger that never resolves leaves the
 * rota holding an open page for a case somebody already answered. The resolve is
 * emitted at the moment `stampFirstResponse` succeeds — in `create-message` —
 * because that call already returns whether THIS reply stopped the clock, which
 * is the exact edge. Discovering it with a second query would mean polling for
 * the absence of a row this process just wrote.
 *
 * IT RUNS WITH PAGING OFF, which is not an oversight. `sendPagerDutyEvent`
 * accepts-and-drops when `ONCALL_ENABLED=false`, and the gauge below is emitted
 * either way — so a deployment selling premium support with no pager can see the
 * obligation it has taken on before it buys the last mile. That is the one
 * number that was previously only visible by reading the table by hand.
 *
 * IDS ONLY. The page carries a case id, an org id and a deadline. The on-call
 * permission is system-org scoped and grants no tenant read access at all, so
 * sending a case subject to a third party through this path would hand out
 * exactly what the permission withholds.
 */

import {
  DEFAULT_LEADER_LOCK_TTL_MS,
  createLogger,
  createScheduler,
  envInt,
  errorMessage,
  leaderLockKey,
  sendPagerDutyEvent,
  type Scheduler,
} from '@pipeline-builder/api-core';
import { setGauge } from '@pipeline-builder/api-server';
import { listCasesDueForPage } from '@pipeline-builder/pipeline-data';

const logger = createLogger('oncall-sweep');

/** Dedup key for a case's page. One shape, so trigger and resolve cannot miss. */
export function casePageKey(caseId: string): string {
  return `case:${caseId}`;
}

export interface OnCallSweepConfig {
  /**
   * How long before `response_due_at` a case starts paging.
   *
   * 120 minutes against premium's eight-hour target: far enough out that a woken
   * human has time to read the case and answer it, and still inside the two-hour
   * margin the fleet alert leaves, so the precise trigger always fires before
   * the coarse one rather than after.
   */
  leadMs: number;
  intervalMs: number;
  /** Cap on cases paged per tick. See the comment at the call site. */
  batchSize: number;
  lockTtlMs: number;
}

export function oncallSweepConfig(): OnCallSweepConfig {
  return {
    leadMs: envInt('ONCALL_CASE_LEAD_MINUTES', 120, { min: 1 }) * 60_000,
    intervalMs: envInt('ONCALL_SWEEP_INTERVAL_MS', 300_000, { min: 10_000 }),
    // A tick that pages more than this is an incident, not a backlog, and the
    // fleet alert covers the shape. Bounded because the alternative is one tick
    // walking an unbounded table while holding the lock.
    batchSize: envInt('ONCALL_SWEEP_BATCH_SIZE', 100, { min: 1 }),
    // CRASH-RECOVERY window only — `withLeaderLock` heartbeats for as long as
    // the tick runs, so this does not have to outlast a slow sweep.
    lockTtlMs: envInt('ONCALL_SWEEP_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1000 }),
  };
}

/**
 * One tick: find the cases inside the lead window, page each, publish the count.
 *
 * Exported for the test, and because the count it returns is the only thing a
 * caller could meaningfully assert on.
 */
export async function runOnCallSweep(
  cfg: OnCallSweepConfig = oncallSweepConfig(),
  signal?: AbortSignal,
): Promise<number> {
  const cases = await listCasesDueForPage(cfg.leadMs, cfg.batchSize);

  // Published BEFORE the pages are sent and on every tick, including the tick
  // that finds nothing: a gauge only reports a state if it is written when the
  // state is zero. Written even with paging disabled — see the module note.
  setGauge('oncall_cases_due', {}, cases.length);
  if (cases.length === 0) return 0;

  let paged = 0;
  for (const c of cases) {
    // Between cases: the lock was lost (another pod is taking over) or we are
    // shutting down. Returning is correct rather than lossy — the next tick
    // re-derives the same set, because nothing here records progress.
    if (signal?.aborted) {
      logger.info('On-call sweep stopping early', { reason: String(signal.reason ?? 'aborted'), paged, pending: cases.length - paged });
      break;
    }
    const dueAt = c.responseDueAt ? new Date(c.responseDueAt).toISOString() : 'unknown';
    // Wrapped per case, not around the loop. `sendPagerDutyEvent` is documented
    // never to throw, and relying on that here would make the batch's survival
    // depend on a promise another module keeps: one unreachable page must not
    // take the other forty-nine with it, and the next tick re-derives the set
    // anyway, so there is nothing to gain by unwinding.
    try {
      const result = await sendPagerDutyEvent({
        dedupKey: casePageKey(c.id),
        action: 'trigger',
        trigger: 'case',
        severity: 'critical',
        // IDS ONLY. Not the subject — see the module note on the permission scope.
        summary: `Premium support case ${c.id} is approaching its first-response target`,
        source: 'pipeline-builder/support',
        component: 'support',
        // The org is PagerDuty's grouping dimension, so one tenant's burst of
        // cases reads as one tenant's problem in an incident timeline.
        group: c.orgId,
        class: 'support.first_response',
        customDetails: {
          caseId: c.id,
          orgId: c.orgId,
          severity: c.severity ?? '',
          responseDueAt: dueAt,
        },
      });
      paged += 1;
      if (!result.ok) {
        logger.error('Could not page for a premium case', { caseId: c.id, error: result.error });
      }
    } catch (err) {
      paged += 1;
      logger.error('Paging threw for a premium case', { caseId: c.id, error: errorMessage(err) });
    }
  }

  logger.info('On-call sweep complete', { due: cases.length, paged });
  return paged;
}

/**
 * Resolve a case's page, because its first response just landed.
 *
 * Called from the `stampFirstResponse` success path, which is the one place that
 * knows the clock stopped on THIS reply. Never throws and never blocks the
 * reply: the customer's answer has already been written, and a failed resolve
 * leaves a stale open page — annoying, and strictly better than a 500 on a
 * support reply that succeeded.
 *
 * Safe when nothing was ever paged. A `resolve` for an unknown `dedup_key` is
 * accepted by Events v2 as a no-op, so this does not need to know whether the
 * case ever reached the window — which is exactly why the sweep can stay
 * stateless.
 */
export async function resolveCasePage(caseId: string): Promise<void> {
  try {
    await sendPagerDutyEvent({ dedupKey: casePageKey(caseId), action: 'resolve', trigger: 'case' });
  } catch (err) {
    logger.error('Could not resolve a case page', { caseId, error: errorMessage(err) });
  }
}

export function createOnCallSweepScheduler(): Scheduler {
  const cfg = oncallSweepConfig();
  logger.info('On-call sweep scheduler starting', {
    leadMinutes: cfg.leadMs / 60_000,
    intervalMs: cfg.intervalMs,
  });
  return createScheduler({
    name: 'oncall-sweep',
    intervalMs: cfg.intervalMs,
    // A short settle before the first tick: paging on a half-booted replica's
    // first database read is how a deploy becomes a page.
    startupDelayMs: envInt('ONCALL_SWEEP_STARTUP_DELAY_MS', 60_000, { min: 0 }),
    run: async (run) => {
      try {
        await runOnCallSweep(cfg, run.signal);
      } catch (err) {
        logger.error('On-call sweep failed', { error: errorMessage(err) });
      }
    },
    // Efficiency, not correctness — the tick is idempotent on `case:<id>`, so
    // the unlocked no-Redis path is safe. See the module note.
    lock: { key: leaderLockKey('message', 'oncall-sweep'), ttlMs: cfg.lockTtlMs },
  });
}
