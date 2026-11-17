// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, createScheduler, nextCronRun, recordAudit, type Scheduler, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID, leaderLockKey, DEFAULT_LEADER_LOCK_TTL_MS } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { schema, withTenantTx, runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { eq, and, isNull, lte, sql } from 'drizzle-orm';
import { executeScan, recoverStaleScans } from './scan-executor.js';

const logger = createLogger('scan-scheduler');

/**
 * How often the scheduler runs (ms). `Config.getAny('compliance')` is loosely
 * typed (returns `unknown`-ish), so we read defensively: every field is
 * defaulted via `??` and coerced with a safe cast rather than asserting the
 * whole shape — a missing or partially-populated config block (e.g. a fresh
 * deploy) should still boot the scheduler with sane defaults.
 */
const complianceConfig = (Config.getAny('compliance') ?? {}) as Partial<{
  scanSchedulerIntervalMs: number;
  scanLockTtlMs: number;
}>;
const SCHEDULER_INTERVAL_MS = Number(complianceConfig.scanSchedulerIntervalMs ?? 60_000);
// Cross-pod single-runner lock so only one replica sweeps per tick (otherwise N
// pods double-execute the same pending scans). The TTL is a CRASH-RECOVERY
// window, not a run-duration cover: the holder heartbeats for as long as a cycle
// runs, so a long sweep keeps its lock (api-core `DEFAULT_LEADER_LOCK_TTL_MS`).
const LOCK_KEY = leaderLockKey('compliance', 'scan-scheduler');
const LOCK_TTL_MS = Number(complianceConfig.scanLockTtlMs ?? DEFAULT_LEADER_LOCK_TTL_MS);

/**
 * The actual sweep: recover stale running scans, process pending scans, then
 * check due schedules.
 *
 * Scheduler is a privileged background tick that legitimately reads + writes
 * across every org; establish a sysadmin tenant context for the whole cycle
 * so the inner queries bypass per-org RLS once it's FORCE'd.
 */
async function sweep(): Promise<void> {
  await runWithTenantContext({ isSuperAdmin: true }, async () => {
    // Fail orphaned `running` scans first (crashed executor) so they don't sit
    // in-progress forever or block rule-change re-scan coalescing. Best-effort:
    // a failure here must not stop pending scans / due schedules from running.
    await recoverStaleScans().catch((err) => logger.error('Stale scan recovery failed', { error: errorMessage(err) }));
    await processPendingScans();
    await checkDueSchedules();
  });
}

// Cross-pod leader lock so that with multiple compliance replicas only ONE pod
// sweeps per window — without it, every replica would re-execute pending scans.
// Without Redis the scheduler runs lock-free on every pod (the conditional-claim
// guards in checkDueSchedules keep that safe).
const scheduler: Scheduler = createScheduler({
  name: 'scan-scheduler',
  intervalMs: SCHEDULER_INTERVAL_MS,
  lock: { key: LOCK_KEY, ttlMs: LOCK_TTL_MS },
  run: sweep,
});

/** Start the background scan scheduler. Safe to call multiple times. */
export function startScanScheduler(): void { scheduler.start(); }

/** Stop the scan scheduler (for graceful shutdown). */
export function stopScanScheduler(): void { scheduler.stop(); }

/**
 * Find and execute all pending scans.
 *
 * System-org scans are claimed like any other: `executeScan` completes them at
 * once with zero counts (the system org is exempt from compliance). Filtering
 * them out here instead left every one — a manual launch, a schedule's run —
 * stuck in `pending` forever.
 */
async function processPendingScans(): Promise<void> {
  const pendingScans = await withTenantTx(async (tx) => tx
    .select({ id: schema.complianceScan.id })
    .from(schema.complianceScan)
    .where(eq(schema.complianceScan.status, 'pending'))
    .limit(10));

  for (const scan of pendingScans) {
    try {
      await executeScan(scan.id);
    } catch (err) {
      logger.error('Failed to execute scan', { scanId: scan.id, error: errorMessage(err) });
    }
  }
}

/** Check active schedules that are due and create scan records for them. */
async function checkDueSchedules(): Promise<void> {
  const now = new Date();

  // System-org schedules are skipped: the system org is exempt from compliance,
  // so their runs would only ever be empty scans.
  const dueSchedules = await withTenantTx(async (tx) => tx
    .select()
    .from(schema.complianceScanSchedule)
    .where(and(
      eq(schema.complianceScanSchedule.isActive, true),
      isNull(schema.complianceScanSchedule.deletedAt),
      lte(schema.complianceScanSchedule.nextRunAt, now),
      sql`lower(${schema.complianceScanSchedule.orgId}) <> ${SYSTEM_ORG_ID}`,
    ))
    .limit(10));

  for (const schedule of dueSchedules) {
    try {
      // The select filters `nextRunAt <= now`, so a due row always has a
      // non-null nextRunAt; narrow the nullable column type for the optimistic
      // claim's equality predicate below.
      const claimedNextRunAt = schedule.nextRunAt;
      if (claimedNextRunAt == null) continue;
      const nextRun = calculateNextRun(schedule.cronExpression);
      // Optimistically CLAIM then insert, in ONE transaction:
      //   1. Advance nextRunAt only if it STILL equals the value we selected.
      //   2. Insert the scan only when that claim won (1 row updated).
      // The conditional update is the concurrency guard. The leader lock is
      // heartbeated, but a lost lock (a Redis blip past the TTL, or no Redis at
      // all, where every pod sweeps) lets a second pod re-select the same
      // still-due schedule. Without the `nextRunAt = <selected>` predicate both pods would advance
      // the schedule and each insert a scan → DUPLICATE scheduled scans (double
      // CPU + double notification fan-out). With it, exactly one pod claims the
      // row; the loser updates 0 rows and skips the insert. Atomic with the scan
      // means a crash/insert-failure rolls back the claim too (retried next tick,
      // never a lost or duplicated scan).
      const created = await withTenantTx(async (tx) => {
        const claimed = await tx.update(schema.complianceScanSchedule)
          .set({ lastRunAt: now, nextRunAt: nextRun, updatedAt: now })
          .where(and(
            eq(schema.complianceScanSchedule.id, schedule.id),
            eq(schema.complianceScanSchedule.nextRunAt, claimedNextRunAt),
            // A schedule deleted between the select and this claim must not fire.
            isNull(schema.complianceScanSchedule.deletedAt),
          ))
          .returning({ id: schema.complianceScanSchedule.id });
        if (claimed.length === 0) return false; // lost the race — another runner claimed it
        const [scan] = await tx.insert(schema.complianceScan).values({
          orgId: schedule.orgId,
          target: schedule.target,
          status: 'pending',
          triggeredBy: 'scheduled',
          userId: schedule.createdBy,
        }).returning({ id: schema.complianceScan.id });
        return scan ?? null;
      });

      if (created) {
        logger.info('Scheduled scan created', {
          scheduleId: schedule.id,
          orgId: schedule.orgId,
          target: schedule.target,
          nextRunAt: nextRun.toISOString(),
        });
        // The same `compliance.scan.create` a person's launch writes, attributed
        // to the schedule's author and marked scheduled — a re-evaluation that
        // can block entities, started by a clock.
        recordAudit({
          action: 'compliance.scan.create',
          actorId: schedule.createdBy || SYSTEM_ACTOR_ID,
          orgId: schedule.orgId,
          targetType: 'scan',
          targetId: created.id,
          details: { target: schedule.target, triggeredBy: 'scheduled', scheduleId: schedule.id, cronExpression: schedule.cronExpression },
        });
      }
    } catch (err) {
      logger.error('Failed to process schedule', {
        scheduleId: schedule.id,
        error: errorMessage(err),
      });
    }
  }
}

/**
 * The next run (strictly after `from`) of a schedule's cron expression, read in
 * UTC. Schedules are UTC by contract: the server's local timezone must never
 * decide when a scan fires, or the same schedule fires at different hours on a
 * host or pod with `TZ` set. A malformed or unsatisfiable expression (only
 * reachable for a row stored before validation) falls back to 1 hour after
 * `from` so the sweep keeps moving.
 */
export function calculateNextRun(cronExpression: string, from: Date = new Date()): Date {
  const next = nextCronRun(cronExpression, from);
  if (next) return next;
  logger.warn('Unparseable cron expression; falling back to +1h', { cronExpression });
  return new Date(from.getTime() + 3600000);
}
