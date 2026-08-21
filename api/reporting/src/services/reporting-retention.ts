// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reporting retention sweep wiring (Phase 7).
 *
 * `pipeline_events`, `deployment_outcomes`, and `incidents` grow unbounded — no
 * TTL. This module runs a leader-locked, batched, split, per-org retention
 * purge on a cadence, reusing the SAME `createScheduler` + env-Redis leader lock
 * primitives the soft-delete purge uses (see pipeline-data's
 * `createSoftDeletePurgeScheduler`). The delete/age logic itself lives in
 * `reportingService.purgeExpiredReportingData` (pipeline-data); this file only
 * schedules it, owns the leader-lock lifecycle, and applies the kill-switch.
 *
 * Env config:
 *   REPORTING_RETENTION_ENABLED            (default true; false ⇒ no sweep)
 *   REPORTING_RETENTION_INTERVAL_HOURS     (default 12)
 *   REPORTING_RETENTION_STARTUP_DELAY_MS   (default 120000 — 2 min settle)
 *   REPORTING_RETENTION_LOCK_TTL_MS        (default 1800000 — 30 min; outlasts a
 *                                           sweep, stays under the interval)
 *   REPORTING_RETENTION_BATCH_SIZE         (default 1000, rows per DELETE)
 *   REPORTING_RETENTION_MAX_BATCHES        (default 50, per table/org/tick)
 *
 * A cross-pod leader lock (when Redis is configured) means only one replica
 * sweeps per window; without Redis it runs on every pod — still safe, since the
 * purge is a batched idempotent DELETE, just redundant.
 */

import {
  createLogger,
  createScheduler,
  createEnvRedisLock,
  closeLeaderLock,
  isBillingEnabled,
  type Scheduler,
} from '@pipeline-builder/api-core';
import { reportingService } from '@pipeline-builder/pipeline-data';

const logger = createLogger('reporting-retention');

function intEnv(name: string, fallback: number, min = 1): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

/** Kill-switch: `REPORTING_RETENTION_ENABLED=false` disables the sweep (rows
 *  accumulate; nothing is purged). */
export function isReportingRetentionEnabled(): boolean {
  return (process.env.REPORTING_RETENTION_ENABLED ?? 'true').toLowerCase() !== 'false';
}

let scheduler: Scheduler | null = null;

/**
 * Build (but do NOT start) the leader-locked reporting-retention scheduler.
 * Returns null when disabled. Exported for unit tests; boot uses
 * start/stopReportingRetention.
 */
export function createReportingRetentionScheduler(): Scheduler | null {
  if (!isReportingRetentionEnabled()) {
    logger.info('Reporting retention scheduler disabled (REPORTING_RETENTION_ENABLED=false)');
    return null;
  }
  // D8: billing OFF ⇒ every org defaults to the `unlimited` tier ⇒ unlimited
  // retention. Purging would silently discard history a billing-disabled
  // deployment is entitled to keep, so skip scheduling entirely (log once at boot).
  if (!isBillingEnabled()) {
    logger.info('Reporting retention scheduler skipped: billing disabled ⇒ unlimited retention (no purge)');
    return null;
  }

  const intervalMs = intEnv('REPORTING_RETENTION_INTERVAL_HOURS', 12) * 60 * 60 * 1000;
  const startupDelayMs = intEnv('REPORTING_RETENTION_STARTUP_DELAY_MS', 120_000, 0);
  const lockTtlMs = intEnv('REPORTING_RETENTION_LOCK_TTL_MS', 1_800_000, 1000);
  const batchSize = intEnv('REPORTING_RETENTION_BATCH_SIZE', 1000);
  const maxBatchesPerTable = intEnv('REPORTING_RETENTION_MAX_BATCHES', 50);
  const lock = createEnvRedisLock();

  logger.info('Reporting retention scheduler starting', {
    intervalHours: intervalMs / 3_600_000,
    locked: !!lock,
  });

  const inner = createScheduler({
    name: 'reporting-retention',
    intervalMs,
    startupDelayMs,
    run: async () => {
      try {
        await reportingService.purgeExpiredReportingData({ batchSize, maxBatchesPerTable });
      } catch (err) {
        logger.error('Reporting retention sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    ...(lock ? { lock: { redis: () => lock, key: 'reporting-retention:leader', ttlMs: lockTtlMs } } : {}),
  });
  if (!lock) return inner;

  // Own the leader-lock Redis client's lifecycle: stop() also closes the
  // connection so it can't keep the process from exiting cleanly.
  return {
    start: () => inner.start(),
    stop: () => { inner.stop(); void closeLeaderLock(lock); },
  };
}

/** Start the reporting retention sweep (idempotent). No-op when disabled. */
export function startReportingRetention(): void {
  if (scheduler) return;
  scheduler = createReportingRetentionScheduler();
  if (scheduler) {
    scheduler.start();
    logger.info('Reporting retention sweep started');
  }
}

/** Stop the sweep (clean shutdown). */
export function stopReportingRetention(): void {
  scheduler?.stop();
  scheduler = null;
}
