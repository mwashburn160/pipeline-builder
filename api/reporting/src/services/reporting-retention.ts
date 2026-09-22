// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reporting retention sweep wiring.
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
  envInt,
  envBool,
  fetchParentOrgId,
  isBillingEnabled,
  resolveRootOrgIdStrict,
  type Scheduler,
  errorMessage,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { reportingService } from '@pipeline-builder/pipeline-data';

const logger = createLogger('reporting-retention');

/** Platform's `GET /organization/:id/parent`, fail-CLOSED (a non-2xx throws). */
async function fetchParentFromPlatform(orgId: string): Promise<string | undefined> {
  return fetchParentOrgId(orgId, {
    authOrgId: SYSTEM_ORG_ID,
    throwOnHttpError: true,
    timeout: 3000,
  });
}

/**
 * Build a per-sweep org → account-ROOT resolver for the retention purge.
 * Retention is a billing entitlement synced onto the root org's `dora_settings`
 * only, so a team's rows must be purged on the ROOT's window. Walks the parent
 * chain via platform (memoized for the sweep, so a root with many teams costs one
 * walk each). Any lookup failure (or a cycle / over-deep chain) resolves to
 * `null`, which makes the sweep SKIP that org this tick — never purge a team's
 * data on the shorter env default because the hierarchy was momentarily unknown.
 */
export function createRetentionRootResolver(
  fetchParent: (orgId: string) => Promise<string | undefined> = fetchParentFromPlatform,
): (orgId: string) => Promise<string | null> {
  const memo = new Map<string, string | null>();
  return async (orgId) => {
    const cached = memo.get(orgId);
    if (cached !== undefined) return cached;
    let root: string | null = null;
    try {
      root = await resolveRootOrgIdStrict(orgId, fetchParent);
      if (root === null) logger.warn('Retention root walk hit a cycle or exceeded max depth; skipping org', { orgId });
    } catch (err) {
      logger.warn('Retention root resolution failed; org skipped this tick', { orgId, error: errorMessage(err) });
    }
    memo.set(orgId, root);
    return root;
  };
}

/** Kill-switch: `REPORTING_RETENTION_ENABLED=false` disables the sweep (rows
 *  accumulate; nothing is purged). */
export function isReportingRetentionEnabled(): boolean {
  return envBool('REPORTING_RETENTION_ENABLED', true);
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
  // Billing OFF ⇒ every org defaults to the `unlimited` tier ⇒ unlimited
  // retention. Purging would silently discard history a billing-disabled
  // deployment is entitled to keep, so skip scheduling entirely (log once at boot).
  if (!isBillingEnabled()) {
    logger.info('Reporting retention scheduler skipped: billing disabled ⇒ unlimited retention (no purge)');
    return null;
  }

  const intervalMs = envInt('REPORTING_RETENTION_INTERVAL_HOURS', 12, { min: 1 }) * 60 * 60 * 1000;
  const startupDelayMs = envInt('REPORTING_RETENTION_STARTUP_DELAY_MS', 120_000, { min: 0 });
  const lockTtlMs = envInt('REPORTING_RETENTION_LOCK_TTL_MS', 1_800_000, { min: 1000 });
  const batchSize = envInt('REPORTING_RETENTION_BATCH_SIZE', 1000, { min: 1 });
  const maxBatchesPerTable = envInt('REPORTING_RETENTION_MAX_BATCHES', 50, { min: 1 });

  logger.info('Reporting retention scheduler starting', {
    intervalHours: intervalMs / 3_600_000,
  });

  return createScheduler({
    name: 'reporting-retention',
    intervalMs,
    startupDelayMs,
    run: async () => {
      try {
        // A fresh resolver per sweep: hierarchy changes (a team moved) are picked
        // up next tick, and the memo never outlives one pass.
        await reportingService.purgeExpiredReportingData({
          batchSize, maxBatchesPerTable, resolveRetentionOrgId: createRetentionRootResolver(),
        });
      } catch (err) {
        logger.error('Reporting retention sweep failed', {
          error: errorMessage(err),
        });
      }
    },
    lock: { key: 'reporting-retention:leader', ttlMs: lockTtlMs },
  });
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
