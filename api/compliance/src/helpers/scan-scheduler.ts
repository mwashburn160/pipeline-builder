// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, createScheduler, createEnvRedisLock, type Scheduler, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { schema, withTenantTx, runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { eq, and, lte, sql } from 'drizzle-orm';
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
  systemOrgScansEnabled: boolean;
  scanLockTtlMs: number;
}>;
const SCHEDULER_INTERVAL_MS = Number(complianceConfig.scanSchedulerIntervalMs ?? 60_000);
const SYSTEM_ORG_SCANS_ENABLED = Boolean(complianceConfig.systemOrgScansEnabled ?? false);
// Cross-pod single-runner lock so only one replica sweeps per tick (otherwise N
// pods double-execute the same pending scans). TTL must outlast one cycle — a
// cycle runs up to 10 scans, so default generously (5 min) and allow override.
const LOCK_KEY = 'compliance:scan-scheduler:leader';
const LOCK_TTL_MS = Number(complianceConfig.scanLockTtlMs ?? 300_000);

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
// Backed by the shared env-configured Redis client (`createEnvRedisLock`); when
// Redis isn't configured it returns null and the scheduler runs lock-free on
// every pod (the conditional-claim guards in checkDueSchedules keep that safe).
const lockClient = createEnvRedisLock();
const scheduler: Scheduler = createScheduler({
  name: 'scan-scheduler',
  intervalMs: SCHEDULER_INTERVAL_MS,
  ...(lockClient ? { lock: { redis: () => lockClient, key: LOCK_KEY, ttlMs: LOCK_TTL_MS } } : {}),
  run: sweep,
});

/** Start the background scan scheduler. Safe to call multiple times. */
export function startScanScheduler(): void { scheduler.start(); }

/** Stop the scan scheduler (for graceful shutdown). */
export function stopScanScheduler(): void { scheduler.stop(); }

/** Find and execute all pending scans. */
async function processPendingScans(): Promise<void> {
  // System-org scans are skipped unless SYSTEM_ORG_SCANS_ENABLED — they tend to
  // be catalog/template seeds, not real workloads, so running them by default
  // wastes cycles and pollutes the audit feed.
  const conditions = [eq(schema.complianceScan.status, 'pending')];
  if (!SYSTEM_ORG_SCANS_ENABLED) {
    // Case-insensitive system-org filter (matches SYSTEM_ORG_ID, which is lowercased at module load).
    conditions.push(sql`lower(${schema.complianceScan.orgId}) <> ${SYSTEM_ORG_ID}`);
  }
  const pendingScans = await withTenantTx(async (tx) => tx
    .select({ id: schema.complianceScan.id })
    .from(schema.complianceScan)
    .where(and(...conditions))
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

  const conditions = [
    eq(schema.complianceScanSchedule.isActive, true),
    lte(schema.complianceScanSchedule.nextRunAt, now),
  ];
  if (!SYSTEM_ORG_SCANS_ENABLED) {
    conditions.push(sql`lower(${schema.complianceScanSchedule.orgId}) <> ${SYSTEM_ORG_ID}`);
  }
  const dueSchedules = await withTenantTx(async (tx) => tx
    .select()
    .from(schema.complianceScanSchedule)
    .where(and(...conditions))
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
      // The conditional update is the concurrency guard. The leader lock isn't
      // renewed mid-sweep, so a long sweep that outlives the lock TTL lets a
      // second pod acquire the lock and re-select the same still-due schedule.
      // Without the `nextRunAt = <selected>` predicate both pods would advance
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
          ))
          .returning({ id: schema.complianceScanSchedule.id });
        if (claimed.length === 0) return false; // lost the race — another runner claimed it
        await tx.insert(schema.complianceScan).values({
          orgId: schedule.orgId,
          target: schedule.target,
          status: 'pending',
          triggeredBy: 'scheduled',
          userId: schedule.createdBy,
        });
        return true;
      });

      if (created) {
        logger.info('Scheduled scan created', {
          scheduleId: schedule.id,
          orgId: schedule.orgId,
          target: schedule.target,
          nextRunAt: nextRun.toISOString(),
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

/** One parsed cron field: the allowed values, and whether it was `*` (unrestricted). */
interface CronField {
  values: ReadonlySet<number>;
  any: boolean;
}

/** A parsed 5-field cron: minute hour day-of-month month day-of-week. */
interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

/** Strict non-negative integer (no signs, decimals, or trailing junk). */
function parseCronInt(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * Parse ONE cron field over `[min, max]`. Supports the standard grammar:
 * `*`, `N`, `a-b`, `*\/n`, `a-b/n`, `N/n` (N through max, step n) and comma
 * lists of any of those. Returns `null` for anything malformed or out of range.
 * Day-of-week accepts 0-7 with 7 folded to Sunday (0).
 */
function parseCronField(spec: string, min: number, max: number, isDow = false): CronField | null {
  if (spec.length === 0) return null;
  const values = new Set<number>();
  const hi = isDow ? 7 : max;
  for (const part of spec.split(',')) {
    const [rangeText, stepText, ...rest] = part.split('/');
    if (rest.length > 0 || rangeText === undefined || rangeText === '') return null;
    let step = 1;
    if (stepText !== undefined) {
      const n = parseCronInt(stepText);
      if (n === null || n < 1) return null;
      step = n;
    }
    let lo: number;
    let top: number;
    if (rangeText === '*') {
      lo = min; top = hi;
      if (isDow && stepText === undefined) top = 6; // `*` = every day once (0-6)
    } else if (rangeText.includes('-')) {
      const [a, b, ...more] = rangeText.split('-');
      const av = parseCronInt(a ?? '');
      const bv = parseCronInt(b ?? '');
      if (more.length > 0 || av === null || bv === null || av > bv) return null;
      lo = av; top = bv;
    } else {
      const v = parseCronInt(rangeText);
      if (v === null) return null;
      lo = v;
      top = stepText !== undefined ? hi : v; // `N/n` = N through max, step n
    }
    if (lo < min || top > hi) return null;
    for (let v = lo; v <= top; v += step) values.add(isDow && v === 7 ? 0 : v);
  }
  return { values, any: spec === '*' };
}

/** Parse a whole 5-field cron expression; `null` if any field is malformed. */
function parseCron(cronExpression: string): ParsedCron | null {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minute = parseCronField(m, 0, 59);
  const hour = parseCronField(h, 0, 23);
  const dayOfMonth = parseCronField(dom, 1, 31);
  const month = parseCronField(mon, 1, 12);
  const dayOfWeek = parseCronField(dow, 0, 6, true);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dom: dayOfMonth, month, dow: dayOfWeek };
}

/**
 * Whether `d` falls on an allowed DAY. Standard (Vixie) cron semantics: when BOTH
 * day-of-month and day-of-week are restricted, a day matching EITHER fires;
 * otherwise the restricted one (or neither) decides.
 */
function dayMatches(c: ParsedCron, d: Date): boolean {
  const domOk = c.dom.values.has(d.getDate());
  const dowOk = c.dow.values.has(d.getDay());
  if (!c.dom.any && !c.dow.any) return domOk || dowOk;
  return domOk && dowOk;
}

/** How far ahead to search before declaring an expression unsatisfiable (e.g. `0 0 31 2 *`). */
const CRON_SEARCH_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;

/**
 * The first minute strictly after `from` that matches `c`, or `null` when none
 * exists within the horizon. Skips whole months/days/hours that can't match, so
 * even a sparse schedule resolves in a few hundred steps.
 */
function nextCronMatch(c: ParsedCron, from: Date): Date | null {
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + CRON_SEARCH_HORIZON_MS;
  while (t.getTime() <= limit) {
    if (!c.month.values.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.values.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.values.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

/**
 * Validate a cron expression: every one of the 5 fields must parse (`*`, values,
 * ranges, `*\/n` / `a-b/n` steps, comma lists) AND the schedule must actually
 * fire (an impossible date like `0 0 31 2 *` is rejected). Exactly the grammar
 * {@link calculateNextRun} honors, so an accepted schedule never silently falls
 * back. Use in route handlers to reject malformed input at insert time.
 */
export function isValidCronExpression(cronExpression: string): boolean {
  const parsed = parseCron(cronExpression);
  return parsed !== null && nextCronMatch(parsed, new Date()) !== null;
}

/** Human-readable rejection reason for `isValidCronExpression`. */
export const CRON_VALIDATION_HINT =
  'Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), each "*", a number, a range (a-b), a step (*/n or a-b/n) or a comma list of those, and must describe a time that actually occurs.';

/**
 * Calculate the next run time (strictly after `from`) for a 5-field cron
 * expression, honoring EVERY field — minute, hour, day-of-month, month and
 * day-of-week — with the grammar {@link isValidCronExpression} accepts. A
 * malformed/unsatisfiable expression (only reachable for a row stored before
 * validation) falls back to 1 hour after `from` so the sweep keeps moving.
 */
export function calculateNextRun(cronExpression: string, from: Date = new Date()): Date {
  const parsed = parseCron(cronExpression);
  const next = parsed ? nextCronMatch(parsed, from) : null;
  if (next) return next;
  logger.warn('Unparseable cron expression; falling back to +1h', { cronExpression });
  return new Date(from.getTime() + 3600000);
}
