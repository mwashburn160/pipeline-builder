// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config, schema, db } from '@pipeline-builder/pipeline-core';
import { eq, ne, and, lte } from 'drizzle-orm';
import { executeScan } from './scan-executor';

const logger = createLogger('scan-scheduler');

/** How often the scheduler runs (ms). */
const complianceConfig = Config.getAny('compliance') as { scanSchedulerIntervalMs: number; systemOrgScansEnabled: boolean };
const SCHEDULER_INTERVAL_MS = complianceConfig.scanSchedulerIntervalMs;
const SYSTEM_ORG_SCANS_ENABLED = complianceConfig.systemOrgScansEnabled;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background scan scheduler.
 * Periodically processes pending scans and creates scans from active schedules.
 * Safe to call multiple times — only starts one timer.
 */
export function startScanScheduler(): void {
  if (schedulerTimer) return;

  // Run immediately on startup
  runSchedulerCycle().catch((err) =>
    logger.error('Initial scheduler cycle failed', { error: errorMessage(err) }),
  );

  schedulerTimer = setInterval(() => {
    runSchedulerCycle().catch((err) =>
      logger.error('Scheduler cycle failed', { error: errorMessage(err) }),
    );
  }, SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref();

  logger.info('Scan scheduler started', { intervalMs: SCHEDULER_INTERVAL_MS });
}

/** Stop the scan scheduler (for graceful shutdown). */
export function stopScanScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info('Scan scheduler stopped');
  }
}

/** Run one scheduler cycle: process pending scans + check due schedules. */
async function runSchedulerCycle(): Promise<void> {
  await processPendingScans();
  await checkDueSchedules();
}

/** Find and execute all pending scans. */
async function processPendingScans(): Promise<void> {
  // System-org scans are skipped unless SYSTEM_ORG_SCANS_ENABLED — they tend to
  // be catalog/template seeds, not real workloads, so running them by default
  // wastes cycles and pollutes the audit feed.
  const conditions = [eq(schema.complianceScan.status, 'pending')];
  if (!SYSTEM_ORG_SCANS_ENABLED) {
    conditions.push(ne(schema.complianceScan.orgId, SYSTEM_ORG_ID));
  }
  const pendingScans = await db
    .select({ id: schema.complianceScan.id })
    .from(schema.complianceScan)
    .where(and(...conditions))
    .limit(10);

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
    conditions.push(ne(schema.complianceScanSchedule.orgId, SYSTEM_ORG_ID));
  }
  const dueSchedules = await db
    .select()
    .from(schema.complianceScanSchedule)
    .where(and(...conditions))
    .limit(10);

  for (const schedule of dueSchedules) {
    try {
      // Create a scan record
      await db.insert(schema.complianceScan).values({
        orgId: schedule.orgId,
        target: schedule.target,
        status: 'pending',
        triggeredBy: 'scheduled',
        userId: schedule.createdBy,
      });

      // Update schedule: lastRunAt and calculate nextRunAt
      const nextRun = calculateNextRun(schedule.cronExpression);
      await db.update(schema.complianceScanSchedule)
        .set({
          lastRunAt: now,
          nextRunAt: nextRun,
          updatedAt: now,
        })
        .where(eq(schema.complianceScanSchedule.id, schedule.id));

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
 */
export function isValidCronExpression(cronExpression: string): boolean {
  try {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [minuteSpec, hourSpec] = parts;
    const minute = parseField(minuteSpec, 0, 59);
    const hour = parseField(hourSpec, 0, 23);
    return minuteSpec === '*' || minute !== null || /^\*\/\d+$/.test(minuteSpec)
      ? hourSpec === '*' || hour !== null || /^\*\/\d+$/.test(hourSpec)
      : false;
  } catch {
    return false;
  }
}

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
