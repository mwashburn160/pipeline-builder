// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stakeholder-report scheduler: producing a period's report with nobody logged in.
 *
 * A SCHEDULED RUN HAS NO CALLER, and everything unusual here follows from that:
 *
 *  - IT IS AUTHORIZED AS THE DEFINITION'S OWNER, re-checked on EVERY run against
 *    platform: still an active member, still holds `reports:author`, and the account
 *    still holds the add-on. Not cached. An entitlement that lapsed on Tuesday must stop
 *    Wednesday's report, and a cache refreshed by a sync leg is exactly one missed sync
 *    away from mailing a report the customer stopped paying for. A check that comes back
 *    REVOKED pauses the definition with the reason, because a report that silently stops
 *    is discovered by the manager who asks where it went; a check that comes back
 *    UNREADABLE only skips this run, because a five-minute platform blip must not pause
 *    every report in the fleet.
 *  - IT RUNS IN `runWithTenantContext` per definition, so RLS is the tenancy gate for the
 *    compose exactly as it is for a request. The due SCAN is the one cross-org read, and
 *    it lives in the store where its sysadmin scope is documented.
 *  - THE CLAIM IS A CONDITIONAL UPDATE, not the leader lock. The lock stops two replicas
 *    sweeping in the same window; it does not stop a long sweep from overlapping the next
 *    leader's. Without `next_run_at = <seen>` both would compose and DELIVER, and the
 *    same manager would get the same report twice from two pods.
 *
 * LOAD CONTROLS, because every weekly definition in the fleet comes due at the same
 * calendar instant: a per-definition jitter spreads the composes across the settle
 * window, a per-cycle concurrency cap bounds how many run at once, and a per-run timeout
 * stops one pathological org holding the lock. The 6-hour SETTLE DELAY exists for a
 * different reason — the ingest redrives its dead-letter queue, so a report composed at
 * 00:00 Monday can disagree with the same report composed at 06:00.
 *
 * Env:
 *   REPORT_SCHEDULER_ENABLED        (default true; false ⇒ nothing is scheduled)
 *   REPORT_SCHEDULER_INTERVAL_MS    (default 300000 — 5 min)
 *   REPORT_SCHEDULER_STARTUP_DELAY_MS (default 60000)
 *   REPORT_SCHEDULER_LOCK_TTL_MS    (default: the shared crash-recovery window)
 *   REPORT_SCHEDULER_BATCH          (default 25, definitions claimed per cycle)
 *   REPORT_SCHEDULER_CONCURRENCY    (default 3, composes in flight)
 *   REPORT_RUN_TIMEOUT_MS           (default 120000, per run)
 *   REPORT_SETTLE_HOURS             (default 6, after a period ends)
 *   REPORT_JITTER_MS                (default 1800000 — up to 30 min)
 *   REPORT_CATCHUP_MAX              (default 4, missed periods per definition)
 */

import {
  createLogger,
  createScheduler,
  DEFAULT_LEADER_LOCK_TTL_MS,
  emitCounter,
  envBool,
  envInt,
  errorMessage,
  leaderLockKey,
  type Scheduler,
} from '@pipeline-builder/api-core';
import {
  completePeriodsSince,
  runWithTenantContext,
  stakeholderReportStore,
  type ReportDefinition,
  type ReportPauseReason,
} from '@pipeline-builder/pipeline-data';
import { deliverPublishedRun, notifyPaused, notifyReadyForReview, notifyRunFailed } from './report-delivery.js';
import { reportIdentity } from './report-identity.js';
import { composeRun } from './report-runner.js';
import { nextRunFor, reportSettleHours } from './report-schedule.js';
import { resolveOrgRollup } from '../helpers/report-helpers.js';

const logger = createLogger('report-scheduler');

/** Kill switch: stops every scheduled run without a redeploy. */
export function isReportSchedulerEnabled(): boolean {
  return envBool('REPORT_SCHEDULER_ENABLED', true);
}

/** The permission a definition's owner must still hold for a run to happen. */
const REQUIRED_PERMISSION = 'reports:author';
/** The feature the account must still hold. */
const REQUIRED_FEATURE = 'stakeholder_reports';

/**
 * What the per-run recheck decided.
 *
 * Three outcomes, not two, and the third is the one that matters: `skip` is "platform
 * could not answer". Fail-closed means the run does NOT happen, but it must not PAUSE the
 * definition either — a five-minute platform blip would otherwise pause every report in
 * the fleet and require a human to resume each one. So the run is skipped, the schedule
 * has already been advanced by the claim, and the next period is attempted normally.
 */
type AuthorityVerdict =
  | { action: 'run' }
  | { action: 'pause'; reason: ReportPauseReason }
  | { action: 'skip' };

/** Re-check the owner and the entitlement for THIS run. */
async function checkAuthority(definition: ReportDefinition): Promise<AuthorityVerdict> {
  const authority = await reportIdentity().authority(definition.orgId, definition.ownerId);
  // A null is "unknown", not "revoked". The client already fails closed by returning null
  // on every error, so this is the one place that decides what closed MEANS here.
  if (!authority) return { action: 'skip' };
  if (!authority.active) return { action: 'pause', reason: 'owner_inactive' };
  if (!authority.permissions.includes(REQUIRED_PERMISSION)) return { action: 'pause', reason: 'permission_lost' };
  if (!authority.features.includes(REQUIRED_FEATURE)) return { action: 'pause', reason: 'entitlement' };
  return { action: 'run' };
}

/** Run `work`, or give up on it after `ms`. */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Produce (and deliver, or queue for review) every period this definition owes.
 *
 * CATCH-UP IS IN ORDER, oldest first, because three weekly reports arriving at once only
 * make sense read downwards. It is also CAPPED: a definition untouched for two years must
 * not produce 104 reports in one cycle, and the oldest of those would be past the
 * retention horizon anyway — which `composeRun` refuses with the reason rather than
 * quietly truncating.
 */
async function runDefinition(definition: ReportDefinition, now: Date): Promise<void> {
  const features = [REQUIRED_FEATURE];
  const orgIds = definition.scope.kind === 'rollup'
    ? await resolveOrgRollup(definition.orgId)
    : undefined;
  const periods = completePeriodsSince(
    definition.cadence,
    definition.timezone,
    definition.weekStart as 'monday' | 'sunday',
    definition.lastRunAt,
    now,
    envInt('REPORT_CATCHUP_MAX', 4, { min: 1 }),
  );

  for (const period of periods) {
    const result = await composeRun({
      definition,
      periodLabel: period.label,
      features,
      ...(orgIds ? { orgIds } : {}),
      now,
    });
    if (!result.ok) {
      // A period the data cannot support is not a failure of the schedule — it is a fact
      // about the org's retention, and the lead is told once per period rather than being
      // left with a gap.
      await notifyRunFailed(definition, period.label, result.refusal.message);
      emitCounter('report_run_refused_total', { orgId: definition.orgId, reason: result.refusal.kind });
      continue;
    }
    if (result.reused) continue;

    if (definition.autoSend) {
      // Auto-send publishes as the OWNER: the run had no caller, and attributing the
      // publish to the person who chose auto-send is the only honest answer.
      const { run } = await stakeholderReportStore.publishRun(definition.orgId, result.run.id, definition.ownerId);
      const outcome = await deliverPublishedRun(definition, run);
      // Recorded on the run, not logged: "did the board actually get last month's?" is
      // asked days later, about one report, by someone reading that report's page.
      await stakeholderReportStore.recordDelivery(
        definition.orgId,
        run.id,
        outcome as unknown as Record<string, unknown>,
      );
    } else {
      await notifyReadyForReview(definition, result.run);
    }
  }
}

/**
 * One cycle: claim what is due, run it, advance the schedule.
 *
 * `run.signal` is checked between definitions. Past a lock loss another pod may be doing
 * the same work, and on shutdown returning promptly is what RELEASES the lock instead of
 * parking the job fleet-wide until the TTL lapses.
 */
async function sweep(run: { signal: AbortSignal }): Promise<void> {
  if (!isReportSchedulerEnabled()) return;
  const now = new Date();
  const batch = envInt('REPORT_SCHEDULER_BATCH', 25, { min: 1 });
  const concurrency = envInt('REPORT_SCHEDULER_CONCURRENCY', 3, { min: 1 });
  const runTimeoutMs = envInt('REPORT_RUN_TIMEOUT_MS', 120_000, { min: 1_000 });

  const due = await stakeholderReportStore.dueDefinitions(now, batch);
  if (due.length === 0) return;
  logger.info('Report definitions due', { count: due.length });

  // A simple worker pool over the claimed list. `concurrency` bounds how many orgs'
  // composes run at once, which is what keeps one busy cycle from saturating the
  // database connection pool the request path shares.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (run.signal.aborted) return;
      const definition = due[cursor];
      cursor += 1;
      if (!definition) return;
      await runOne(definition, now, runTimeoutMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
}

/** Claim, authorize and run ONE definition. Never throws. */
async function runOne(definition: ReportDefinition, now: Date, timeoutMs: number): Promise<void> {
  const seen = definition.nextRunAt;
  if (!seen) return; // the scan filters on it; a null here means the row changed under us

  try {
    // Claim FIRST, before any expensive work: the whole point is that a second sweep
    // finds the row already advanced and skips it, and a claim taken after the compose
    // would leave a window wide enough to duplicate a delivery.
    const claimed = await stakeholderReportStore.claimDefinition(
      definition.id,
      seen,
      nextRunFor(definition, now),
      now,
    );
    if (!claimed) {
      emitCounter('report_claim_lost_total', { orgId: definition.orgId });
      return;
    }

    const verdict = await checkAuthority(definition);
    if (verdict.action === 'skip') {
      logger.warn('Owner authority unreadable; skipping this run', { definitionId: definition.id });
      emitCounter('report_authority_unavailable_total', { orgId: definition.orgId });
      return;
    }
    if (verdict.action === 'pause') {
      await stakeholderReportStore.pauseDefinition(definition.id, verdict.reason);
      await notifyPaused(definition, verdict.reason);
      logger.info('Report definition paused', { definitionId: definition.id, reason: verdict.reason });
      return;
    }

    await runWithTenantContext({ orgId: definition.orgId, isSuperAdmin: false }, () =>
      withTimeout(runDefinition(definition, now), timeoutMs, `report run ${definition.id}`));
  } catch (err) {
    // The schedule has already been advanced by the claim, so a thrown run costs this
    // period and not the next one. That is deliberate: a definition that fails every
    // cycle would otherwise be retried forever and starve the rest of the batch.
    logger.error('Report run failed', {
      definitionId: definition.id,
      orgId: definition.orgId,
      error: errorMessage(err),
    });
    emitCounter('report_run_error_total', { orgId: definition.orgId, cadence: definition.cadence });
  }
}

let scheduler: Scheduler | null = null;

/**
 * Build (but do not start) the leader-locked report scheduler, or null when disabled.
 * Exported for tests; boot uses start/stop below.
 */
export function createReportScheduler(): Scheduler | null {
  if (!isReportSchedulerEnabled()) {
    logger.info('Report scheduler disabled (REPORT_SCHEDULER_ENABLED=false)');
    return null;
  }
  return createScheduler({
    name: 'report-scheduler',
    intervalMs: envInt('REPORT_SCHEDULER_INTERVAL_MS', 300_000, { min: 1_000 }),
    startupDelayMs: envInt('REPORT_SCHEDULER_STARTUP_DELAY_MS', 60_000, { min: 0 }),
    run: sweep,
    // A CRASH-RECOVERY window, not a run-duration cover: withLeaderLock heartbeats for as
    // long as the sweep runs, so this is only how long a dead pod parks the job.
    lock: {
      key: leaderLockKey('reporting', 'report-scheduler'),
      ttlMs: envInt('REPORT_SCHEDULER_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1_000 }),
    },
  });
}

/** Start the report scheduler (idempotent). No-op when disabled. */
export function startReportScheduler(): void {
  if (scheduler) return;
  scheduler = createReportScheduler();
  if (scheduler) {
    scheduler.start();
    logger.info('Report scheduler started', { settleHours: reportSettleHours() });
  }
}

/** Stop the report scheduler (clean shutdown). */
export function stopReportScheduler(): void {
  scheduler?.stop();
  scheduler = null;
}
