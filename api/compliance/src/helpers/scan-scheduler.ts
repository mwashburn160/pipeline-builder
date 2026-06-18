// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, createScheduler, type Scheduler, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config, schema, withTenantTx, runWithTenantContext } from '@pipeline-builder/pipeline-core';
import { eq, and, lte, sql } from 'drizzle-orm';
import { executeScan } from './scan-executor.js';
import { getLockRedis } from '../queue/compliance-event-queue.js';

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
 * The actual sweep: process pending scans + check due schedules.
 *
 * Scheduler is a privileged background tick that legitimately reads + writes
 * across every org; establish a sysadmin tenant context for the whole cycle
 * so the inner queries bypass per-org RLS once it's FORCE'd.
 */
async function sweep(): Promise<void> {
  await runWithTenantContext({ isSuperAdmin: true }, async () => {
    await processPendingScans();
    await checkDueSchedules();
  });
}

// Cross-pod leader lock so that with multiple compliance replicas only ONE pod
// sweeps per window — without it, every replica would re-execute pending scans.
const scheduler: Scheduler = createScheduler({
  name: 'scan-scheduler',
  intervalMs: SCHEDULER_INTERVAL_MS,
  lock: { redis: getLockRedis, key: LOCK_KEY, ttlMs: LOCK_TTL_MS },
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
      // Create a scan record
      await withTenantTx(async (tx) => tx.insert(schema.complianceScan).values({
        orgId: schedule.orgId,
        target: schedule.target,
        status: 'pending',
        triggeredBy: 'scheduled',
        userId: schedule.createdBy,
      }));

      // Update schedule: lastRunAt and calculate nextRunAt
      const nextRun = calculateNextRun(schedule.cronExpression);
      await withTenantTx(async (tx) => tx.update(schema.complianceScanSchedule)
        .set({
          lastRunAt: now,
          nextRunAt: nextRun,
          updatedAt: now,
        })
        .where(eq(schema.complianceScanSchedule.id, schedule.id)));

      logger.info('Scheduled scan created', {
        scheduleId: schedule.id,
        orgId: schedule.orgId,
        target: schedule.target,
        nextRunAt: nextRun.toISOString(),
      });
    } catch (err) {
      logger.error('Failed to process schedule', {
        scheduleId: schedule.id,
        error: errorMessage(err),
      });
    }
  }
}

/**
 * Validate a cron expression. Returns true if `calculateNextRun` would
 * succeed without falling back to the safety value. Use in route handlers
 * to reject malformed input at insert time, rather than silently storing
 * a schedule that resolves to "1 hour from now" forever.
 *
 * Only the minute and hour fields are honored by `calculateNextRun`; the
 * day-of-month, month, and day-of-week fields are ignored. Reject any
 * expression where those three fields aren't `*` so users don't think
 * `0 6 * * 1` will actually fire weekly. (We avoid taking on `cron-parser`
 * as a dependency just for one helper.)
 */
export function isValidCronExpression(cronExpression: string): boolean {
  try {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [minuteSpec, hourSpec, dom, month, dow] = parts;
    if (dom !== '*' || month !== '*' || dow !== '*') return false;

    const minuteOk = minuteSpec === '*'
      || parseField(minuteSpec, 0, 59) !== null
      || /^\*\/\d+$/.test(minuteSpec);
    const hourOk = hourSpec === '*'
      || parseField(hourSpec, 0, 23) !== null
      || /^\*\/\d+$/.test(hourSpec);
    return minuteOk && hourOk;
  } catch {
    return false;
  }
}

/** Human-readable rejection reason for `isValidCronExpression`. */
export const CRON_VALIDATION_HINT =
  'Cron expression must have exactly 5 fields and the day-of-month, month, and day-of-week fields must be "*". Only minute and hour are honored.';

/**
 * Calculate the next run time from a cron expression.
 * Supports standard 5-field cron: minute hour dayOfMonth month dayOfWeek.
 * Falls back to 1 hour from now if parsing fails.
 */
export function calculateNextRun(cronExpression: string): Date {
  try {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
    }

    const [minuteSpec, hourSpec] = parts;
    const now = new Date();
    const next = new Date(now);

    // Simple parser for common patterns:
    // "0 * * * *" = every hour at :00
    // "*/15 * * * *" = every 15 minutes
    // "0 0 * * *" = daily at midnight
    // "0 6 * * 1" = weekly Monday at 6am

    const minute = parseField(minuteSpec, 0, 59);
    const hour = parseField(hourSpec, 0, 23);

    if (minute !== null && hour !== null) {
      // Specific time: next occurrence of HH:MM
      next.setMinutes(minute, 0, 0);
      next.setHours(hour);
      if (next <= now) next.setDate(next.getDate() + 1);
    } else if (minute !== null) {
      // Every hour at :MM
      next.setMinutes(minute, 0, 0);
      if (next <= now) next.setHours(next.getHours() + 1);
    } else if (minuteSpec.startsWith('*/')) {
      // Every N minutes
      const interval = parseInt(minuteSpec.slice(2), 10);
      if (interval > 0 && interval <= 60) {
        const currentMinute = now.getMinutes();
        const nextMinute = Math.ceil((currentMinute + 1) / interval) * interval;
        next.setMinutes(nextMinute, 0, 0);
        if (next <= now) next.setMinutes(next.getMinutes() + interval);
      } else {
        next.setTime(now.getTime() + 3600000);
      }
    } else {
      // Fallback: 1 hour from now
      next.setTime(now.getTime() + 3600000);
    }

    return next;
  } catch {
    // Fallback: 1 hour from now
    return new Date(Date.now() + 3600000);
  }
}

/** Parse a single cron field. Returns the value if it's a literal number, null otherwise. */
function parseField(field: string, min: number, max: number): number | null {
  if (field === '*') return null;
  const num = parseInt(field, 10);
  if (Number.isFinite(num) && num >= min && num <= max) return num;
  return null;
}
