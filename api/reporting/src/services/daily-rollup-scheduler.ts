// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Daily-rollup scheduler wiring.
 *
 * `execution_daily_rollups` is what every analytics section reads (breakdown,
 * failures, stages, resources, adoption, streaks). It is WRITTEN only by
 * pipeline-data's `runRollupPass`, which rebuilds the most recent settled days —
 * so without a caller the table stays empty and every one of those sections reads
 * nothing. This module is that caller: a leader-locked `createScheduler` tick,
 * the same primitives as the retention sweep.
 *
 * `runRollupPass` never throws (a failed day is logged and retried next pass) and
 * each day's rebuild is an idempotent delete-and-insert, so a pass that runs on
 * two pods (no Redis) is redundant work, not wrong data.
 *
 * Env config:
 *   REPORTING_ROLLUP_ENABLED            (default true; false ⇒ no rollup)
 *   REPORTING_ROLLUP_INTERVAL_MINUTES   (default 60)
 *   REPORTING_ROLLUP_STARTUP_DELAY_MS   (default 60000 — 1 min settle)
 *   REPORTING_ROLLUP_LOCK_TTL_MS        (default: the shared crash-recovery window)
 * The settle window and batch size are pipeline-data's own
 * (`ROLLUP_SETTLE_HOURS`, `ROLLUP_BATCH_DAYS`).
 */

import {
  createLogger,
  createScheduler,
  envBool,
  envInt,
  errorMessage,
  leaderLockKey,
  DEFAULT_LEADER_LOCK_TTL_MS,
  type Scheduler,
} from '@pipeline-builder/api-core';
import { runRollupPass } from '@pipeline-builder/pipeline-data';

const logger = createLogger('daily-rollup');

/** Kill-switch for the rollup scheduler. */
export function isDailyRollupEnabled(): boolean {
  return envBool('REPORTING_ROLLUP_ENABLED', true);
}

let scheduler: Scheduler | null = null;

/**
 * Build the rollup scheduler, or `null` when disabled. Exported for tests; the
 * service uses {@link startDailyRollup} / {@link stopDailyRollup}.
 */
export function createDailyRollupScheduler(
  pass: (now?: Date) => Promise<{ days: number; rows: number }> = runRollupPass,
): Scheduler | null {
  if (!isDailyRollupEnabled()) {
    logger.info('Daily rollup disabled (REPORTING_ROLLUP_ENABLED=false)');
    return null;
  }
  const intervalMs = envInt('REPORTING_ROLLUP_INTERVAL_MINUTES', 60) * 60_000;
  const startupDelayMs = envInt('REPORTING_ROLLUP_STARTUP_DELAY_MS', 60_000);
  const lockTtlMs = envInt('REPORTING_ROLLUP_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS);
  return createScheduler({
    name: 'daily-rollup',
    intervalMs,
    startupDelayMs,
    run: async () => {
      try {
        const { days, rows } = await pass();
        logger.info('Daily rollup pass complete', { days, rows });
      } catch (err) {
        // runRollupPass is documented never to throw; guard anyway so a future
        // change can't take the scheduler down.
        logger.error('Daily rollup pass failed', { error: errorMessage(err) });
      }
    },
    lock: { key: leaderLockKey('reporting', 'daily-rollup'), ttlMs: lockTtlMs },
  });
}

/** Start the daily rollup (idempotent). No-op when disabled. */
export function startDailyRollup(): void {
  if (scheduler) return;
  scheduler = createDailyRollupScheduler();
  if (scheduler) {
    scheduler.start();
    logger.info('Daily rollup scheduler started');
  }
}

/** Stop the daily rollup (idempotent). */
export function stopDailyRollup(): void {
  scheduler?.stop();
  scheduler = null;
}
