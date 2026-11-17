// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stakeholder-report scheduler: producing a period's report with nobody logged in.
 *
 * A SCHEDULED RUN HAS NO CALLER, and everything unusual here follows from that:
 *
 *  - IT IS AUTHORIZED AS THE DEFINITION'S OWNER, re-checked on EVERY run against
 *    platform: still an active member, still holds `reports:write` (and
 *    `reports:rollup` when the definition rolls up its teams), and the account
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
  recordAudit,
  type Permission,
  type Scheduler,
} from '@pipeline-builder/api-core';
import {
  completePeriodsSince,
  runWithTenantContext,
  stakeholderReportStore,
  type ReportDefinition,
  type ReportPauseReason,
} from '@pipeline-builder/pipeline-data';
import { attachExecutiveSummary } from './report-ai-summary.js';
import { deliverAndRecord, notifyPaused, notifyReadyForReview, notifyRunFailed } from './report-delivery.js';
import { reportIdentity } from './report-identity.js';
import { composeRun } from './report-runner.js';
import { nextRunFor, reportSettleHours } from './report-schedule.js';
import { createRetentionRootResolver } from './reporting-retention.js';
import { resolveOrgSubtree } from '../helpers/report-helpers.js';

const logger = createLogger('report-scheduler');

/** Kill switch: stops every scheduled run without a redeploy. */
export function isReportSchedulerEnabled(): boolean {
  return envBool('REPORT_SCHEDULER_ENABLED', true);
}

/** The permission a definition's owner must still hold for a run to happen. */
const REQUIRED_PERMISSION: Permission = 'reports:write';
/**
 * The extra grant a ROLLUP definition's owner must still hold: reading descendant
 * teams' data is `reports:rollup`, a separate grant from reading your own org's.
 * The on-demand run route re-checks it on every compose; a scheduled run has to as
 * well, or a lead whose rollup grant was withdrawn keeps receiving — and auto-sending
 * — the teams' numbers every period.
 */
const ROLLUP_PERMISSION: Permission = 'reports:rollup';

/**
 * An AUTO-SEND definition publishes as its owner, so the owner must still hold
 * the permission a manual publish needs. Losing it pauses the definition rather
 * than quietly mailing on the strength of `reports:write` alone.
 */
const PUBLISH_PERMISSION: Permission = 'reports:publish';
/** The feature the account must still hold. */
const REQUIRED_FEATURE = 'stakeholder_reports';

/**
 * What the per-run recheck decided.
 *
 * Three outcomes, not two, and the third is the one that matters: `skip` is "platform
 * could not answer". Fail-closed means the run does NOT happen, but it must not PAUSE the
 * definition either — a five-minute platform blip would otherwise pause every report in
 * the fleet and require a human to resume each one. So the run is skipped BEFORE the
 * claim: the definition stays due and the next cycle retries the same periods.
 */
type AuthorityVerdict =
  // The account's REAL feature set travels with the verdict, because the AI draft needs to
  // know whether `ai_generation` is held and the authority read already fetched it — asking
  // platform twice for the same answer would be a second chance to disagree with itself.
  | { action: 'run'; features: readonly string[] }
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
  if (definition.scope.kind === 'rollup' && !authority.permissions.includes(ROLLUP_PERMISSION)) {
    return { action: 'pause', reason: 'permission_lost' };
  }
  if (definition.autoSend && !authority.permissions.includes(PUBLISH_PERMISSION)) {
    return { action: 'pause', reason: 'permission_lost' };
  }
  if (!authority.features.includes(REQUIRED_FEATURE)) return { action: 'pause', reason: 'entitlement' };
  return { action: 'run', features: authority.features };
}

/**
 * Run `work`, and after `ms` both stop waiting for it AND abort it.
 *
 * Giving up on the promise alone is not a timeout: the run keeps going in the
 * background and its side effects — publishing, DELIVERY to the recipients, the
 * lead's notification — land minutes later, after the cycle already logged it as
 * failed. So `work` receives a signal the timeout aborts, and checks it before
 * every side effect ({@link runDefinition}); the abort reason is the timeout error.
 */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} exceeded ${ms}ms`);
          controller.abort(err);
          reject(err);
        }, ms);
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
async function runDefinition(
  definition: ReportDefinition,
  now: Date,
  authorityFeatures: readonly string[],
  retentionOrgId: string,
  signal: AbortSignal,
): Promise<void> {
  // The COMPOSE runs on the add-on's own feature, which is what a scheduled report is
  // authorized by; the AI draft below uses the account's real set, because it needs to know
  // about `ai_generation` specifically.
  const features = [REQUIRED_FEATURE];
  // STRICT: an unreachable platform throws here (and `runOne` logs and counts it)
  // rather than composing a rollup that silently covers the parent org alone —
  // a report labelled as covering the teams that quietly does not is a wrong
  // report, and with auto-send it is a wrong report already in a manager's inbox.
  const orgIds = definition.scope.kind === 'rollup'
    ? await resolveOrgSubtree(definition.orgId)
    : undefined;
  const periods = completePeriodsSince(
    definition.cadence,
    definition.timezone,
    definition.weekStart,
    definition.lastRunAt,
    now,
    envInt('REPORT_CATCHUP_MAX', 4, { min: 1 }),
  );

  for (const period of periods) {
    // A timed-out run stops here and before each side effect below — never after
    // one has begun, so a report is either delivered whole or not at all.
    signal.throwIfAborted();
    const result = await composeRun({
      definition,
      periodLabel: period.label,
      features,
      ...(orgIds ? { orgIds } : {}),
      retentionOrgId,
      now,
    });
    signal.throwIfAborted();
    if (!result.ok) {
      // A period the data cannot support is not a failure of the schedule — it is a fact
      // about the org's retention, and the lead is told once per period rather than being
      // left with a gap.
      await notifyRunFailed(definition, period.label, result.refusal.message);
      emitCounter('report_run_refused_total', { reason: result.refusal.kind });
      continue;
    }
    // A period someone already generated by hand (POST /definitions/:id/runs) comes
    // back REUSED. For a review-mode report that is the end of it — the lead made it
    // themselves. An auto-send report still owes its delivery unless it was already
    // published: skipping it here would advance past the period with nobody mailed.
    if (result.reused && (!definition.autoSend || result.run.publishedAt)) continue;

    if (definition.autoSend) {
      // Auto-send publishes as the OWNER: the run had no caller, and attributing the
      // publish to the person who chose auto-send is the only honest answer.
      const { run, alreadyPublished } = await stakeholderReportStore.publishRun(definition.orgId, result.run.id, definition.ownerId);
      // A person published it between the compose and here: their publish delivered it.
      if (alreadyPublished) continue;
      // Delivers, records the outcome on the run and tells the lead if it left anyone
      // out — "did the board actually get last month's?" is asked days later, about
      // one report, by someone reading that report's page, so it lives on the run.
      const outcome = await deliverAndRecord(definition, run);
      // The same record a manual publish writes (routes/stakeholder-reports.ts),
      // because the effect is the same — internal delivery numbers left the
      // platform — and an automatic release is the one nobody clicked, so the
      // trail is the only place it is visible. Actor = the OWNER, as above;
      // `trigger: 'schedule'` is what tells it apart from a person's publish.
      recordAudit({
        action: run.version > 1 ? 'reporting.report.republished' : 'reporting.report.published',
        actorId: definition.ownerId,
        orgId: definition.orgId,
        targetType: 'report-run',
        targetId: run.id,
        details: {
          trigger: 'schedule',
          definitionId: run.definitionId,
          period: run.periodLabel,
          version: run.version,
          recipients: outcome.email.sent + outcome.inApp,
          emailFailed: outcome.email.failed,
          destinationsDelivered: outcome.destinations.delivered,
        },
      });
    } else {
      // The draft is attached BEFORE the lead is told, so the review screen they open has
      // something to edit rather than an empty box they have to come back to. Best-effort:
      // `attachExecutiveSummary` never throws, and a report with no draft is still a
      // report — the reason travels with it.
      // No request signal here; the run's timeout signal aborts it, and it is still
      // bounded by AI_REQUEST_TIMEOUT_MS.
      // No request either, so the aiCalls unit is attributed explicitly — to the
      // OWNER the run is authorized as (their per-member share, when the account
      // set one, is what an automatic draft draws on) and a schedule pseudo-route.
      const summary = await attachExecutiveSummary(result.run, {
        snapshot: result.run.snapshot as never,
        orgId: definition.orgId,
        features: authorityFeatures,
        attribution: { principalType: 'user', principalId: definition.ownerId, route: 'schedule:report-summary' },
        signal,
      }, stakeholderReportStore);
      // The same record the manual (re)draft route writes: the org's numbers went to
      // an AI provider, on whose key, for how many tokens. Actor = the OWNER the run is
      // authorized as; `trigger: 'schedule'` tells it apart from a person's click.
      recordAudit({
        action: 'reporting.report.run.summary',
        actorId: definition.ownerId,
        orgId: definition.orgId,
        targetType: 'report-run',
        targetId: result.run.id,
        outcome: summary.ok ? 'success' : 'failure',
        details: {
          trigger: 'schedule',
          definitionId: result.run.definitionId,
          period: result.run.periodLabel,
          version: result.run.version,
          ...(summary.ok ? {} : { reason: summary.reason }),
          ...(summary.ai ? { ai: summary.ai } : {}),
        },
      });
      // The summary attempt is audited above even when the timeout cut it short
      // (the provider call was made); the lead is only told about a run that finished.
      signal.throwIfAborted();
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
  // One root resolver per cycle: a root with many teams is walked once, and a hierarchy
  // change is picked up on the next cycle.
  const retentionRootOf = createRetentionRootResolver();

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
      await runOne(definition, now, runTimeoutMs, retentionRootOf);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
}

/** Claim, authorize and run ONE definition. Never throws. */
async function runOne(
  definition: ReportDefinition,
  now: Date,
  timeoutMs: number,
  retentionRootOf: (orgId: string) => Promise<string | null>,
): Promise<void> {
  const seen = definition.nextRunAt;
  if (!seen) return; // the scan filters on it; a null here means the row changed under us

  try {
    // Retention is billing-synced onto the account ROOT only, so a team's report must be
    // bounded by its root's window — the same one the on-demand run route reads off the
    // caller's token. Read against the team's own row it fell back to the env default, and
    // a team's monthly report was refused as "past your retention horizon" every period
    // while the same run composed fine by hand.
    //
    // Resolved BEFORE the claim, because the claim advances `lastRunAt` and the periods a
    // run owes are counted from it: a lookup that failed after the claim lost those periods
    // for good. Unresolvable ⇒ the definition is left unclaimed and still due, so the next
    // cycle retries the same periods. The lookup is a side-effect-free read (memoized per
    // cycle on success), so taking it ahead of the claim opens no duplicate-delivery window.
    const retentionOrgId = await retentionRootOf(definition.orgId);
    if (!retentionOrgId) {
      logger.warn('Account root unresolvable; leaving the definition due for the next cycle', { definitionId: definition.id });
      emitCounter('report_retention_root_unavailable_total', {});
      return;
    }

    // The owner's authority is read BEFORE the claim for the same reason: it is a
    // side-effect-free read, and an unreadable answer (a platform blip) taken after
    // the claim would lose the periods the claim just advanced past. Unreadable ⇒
    // left unclaimed and still due, so the next cycle retries the same periods.
    const verdict = await checkAuthority(definition);
    if (verdict.action === 'skip') {
      logger.warn('Owner authority unreadable; leaving the definition due for the next cycle', { orgId: definition.orgId, definitionId: definition.id });
      emitCounter('report_authority_unavailable_total', {});
      return;
    }

    // Claim before any expensive work: the whole point is that a second sweep
    // finds the row already advanced and skips it, and a claim taken after the compose
    // would leave a window wide enough to duplicate a delivery.
    const claimed = await stakeholderReportStore.claimDefinition(
      definition.id,
      seen,
      nextRunFor(definition, now),
      now,
    );
    if (!claimed) {
      emitCounter('report_claim_lost_total', {});
      return;
    }

    if (verdict.action === 'pause') {
      await stakeholderReportStore.pauseDefinition(definition.id, verdict.reason);
      await notifyPaused(definition, verdict.reason);
      logger.info('Report definition paused', { definitionId: definition.id, reason: verdict.reason });
      return;
    }

    await runWithTenantContext({ orgId: definition.orgId, isSuperAdmin: false }, () =>
      withTimeout((signal) => runDefinition(definition, now, verdict.features, retentionOrgId, signal), timeoutMs, `report run ${definition.id}`));
  } catch (err) {
    // The schedule has already been advanced by the claim, so a thrown run costs this
    // period and not the next one. That is deliberate: a definition that fails every
    // cycle would otherwise be retried forever and starve the rest of the batch.
    logger.error('Report run failed', {
      definitionId: definition.id,
      orgId: definition.orgId,
      error: errorMessage(err),
    });
    emitCounter('report_run_error_total', { cadence: definition.cadence });
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
