// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared soft-delete retention purge.
 *
 * Every {@link CrudService} entity soft-deletes (sets `deletedAt` + a
 * `purge_after` deadline). This orchestrator runs one purge pass across a set
 * of such entities, hard-deleting tombstones whose deadline has passed. It is
 * the `run` callback a service hands to `createScheduler` (leader-locked), so
 * only one pod sweeps at a time.
 *
 * Runs in an explicit **sysadmin tenant scope** (`runWithTenantContext({
 * isSuperAdmin: true })`) so the underlying `purgeExpired` spans every org and
 * bypasses RLS on FORCE'd tables (plugins/pipelines/etc.). A bare no-tenant
 * context would see zero rows on those tables — and in production (`strict`
 * mode) `withTenantTx` throws outright — so the scope is established here rather
 * than left to the caller. This is a cross-tenant housekeeping job, not a
 * per-org operation.
 */

import { createLogger, createScheduler, createEnvRedisLock, type Scheduler } from '@pipeline-builder/api-core';
import { runWithTenantContext } from '../database/tenancy.js';

const logger = createLogger('soft-delete-sweep');

/** The slice of a CrudService the sweep needs, plus a label for logs/metrics. */
export interface PurgeableEntity {
  /** Table/entity label (e.g. 'pipeline') for per-table logging. */
  name: string;
  /** Hard-delete up to `limit` expired tombstones; returns rows purged. */
  purgeExpired(now: Date, limit?: number): Promise<number>;
}

export interface SoftDeletePurgeOptions {
  /** Rows per batch per table (default 500). */
  batchSize?: number;
  /** Max batches per table per tick (default 20 → ≤ 10k/table/tick); the rest
   *  is deferred to the next tick so a huge backlog can't blow the lock TTL. */
  maxBatchesPerEntity?: number;
}

/** Kill-switch: `SOFT_DELETE_PURGE_ENABLED=false` disables all hard-purging
 *  (tombstones still accumulate + stay restorable; nothing is destroyed). */
export function isSoftDeletePurgeEnabled(): boolean {
  return (process.env.SOFT_DELETE_PURGE_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Run one purge sweep across `entities`. Loops each entity's `purgeExpired` in
 * batches until a batch returns `< batchSize` (drained) or the per-tick cap is
 * hit (logged; continued next tick). Never throws — a failing entity is logged
 * and the sweep moves on. Returns per-entity purged counts (also logged).
 */
export async function runSoftDeletePurge(
  entities: PurgeableEntity[],
  opts: SoftDeletePurgeOptions = {},
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (!isSoftDeletePurgeEnabled()) {
    logger.debug('Soft-delete purge disabled (SOFT_DELETE_PURGE_ENABLED=false)');
    return counts;
  }

  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatchesPerEntity ?? 20;
  // One `now` for the whole tick — rows that expire mid-sweep wait for the next.
  const now = new Date();

  // Establish a sysadmin scope so every `purgeExpired` (which routes through
  // `withTenantTx`) bypasses RLS and spans all orgs. Without this, FORCE'd
  // tables return zero rows and production `strict` mode throws.
  return runWithTenantContext({ isSuperAdmin: true }, async () => {
    for (const entity of entities) {
      let total = 0;
      for (let i = 0; i < maxBatches; i++) {
        let purged: number;
        try {
          purged = await entity.purgeExpired(now, batchSize);
        } catch (err) {
          logger.error('Purge batch failed', { entity: entity.name, error: String(err) });
          break;
        }
        total += purged;
        if (purged < batchSize) break; // drained
        if (i === maxBatches - 1) {
          logger.warn('Purge hit per-tick cap; remaining tombstones deferred to next tick', {
            entity: entity.name, purgedThisTick: total,
          });
        }
      }
      if (total > 0) logger.info('Purged expired soft-deleted rows', { entity: entity.name, count: total });
      counts[entity.name] = total;
    }

    return counts;
  });
}

// -- Scheduler factory --------------------------------------------------------

export interface SoftDeletePurgeSchedulerOptions extends SoftDeletePurgeOptions {
  /** Service label for logs + the leader-lock key (e.g. 'pipeline', 'plugin'). */
  service: string;
  /** Entities to sweep — usually the service's own CrudService singletons. */
  entities: PurgeableEntity[];
}

/**
 * Build (but do NOT start) a leader-locked scheduler that runs the soft-delete
 * purge sweep for `entities` on a cadence. The caller `.start()`s it and wires
 * `stop()` to SIGTERM. Returns null when purging is disabled.
 *
 * Env config:
 *   SOFT_DELETE_PURGE_ENABLED           (default true; false ⇒ null, no sweep)
 *   SOFT_DELETE_PURGE_INTERVAL_HOURS    (default 6)
 *   SOFT_DELETE_PURGE_STARTUP_DELAY_MS  (default 120000 — 2 min settle)
 *   SOFT_DELETE_PURGE_LOCK_TTL_MS       (default 900000 — 15 min; outlasts a
 *                                        sweep, stays under the interval)
 *
 * A cross-pod leader lock (when Redis is configured) means only one replica
 * sweeps per window; without Redis it runs on every pod — still safe, since the
 * purge is a batched idempotent DELETE, just redundant.
 */
export function createSoftDeletePurgeScheduler(opts: SoftDeletePurgeSchedulerOptions): Scheduler | null {
  if (!isSoftDeletePurgeEnabled()) {
    logger.info('Soft-delete purge scheduler disabled (SOFT_DELETE_PURGE_ENABLED=false)', { service: opts.service });
    return null;
  }

  const intervalMs = Math.max(1, Number.parseInt(process.env.SOFT_DELETE_PURGE_INTERVAL_HOURS ?? '6', 10) || 6) * 60 * 60 * 1000;
  const startupDelayMs = Math.max(0, Number.parseInt(process.env.SOFT_DELETE_PURGE_STARTUP_DELAY_MS ?? '120000', 10) || 0);
  const lockTtlMs = Math.max(1000, Number.parseInt(process.env.SOFT_DELETE_PURGE_LOCK_TTL_MS ?? '900000', 10) || 900000);
  const lock = createEnvRedisLock();

  logger.info('Soft-delete purge scheduler starting', {
    service: opts.service,
    entities: opts.entities.map((e) => e.name),
    intervalHours: intervalMs / 3_600_000,
    locked: !!lock,
  });

  return createScheduler({
    name: `soft-delete-purge:${opts.service}`,
    intervalMs,
    startupDelayMs,
    run: async () => { await runSoftDeletePurge(opts.entities, opts); },
    ...(lock ? { lock: { redis: () => lock, key: `soft-delete-purge:${opts.service}:leader`, ttlMs: lockTtlMs } } : {}),
  });
}
