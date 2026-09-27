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

import { createLogger, createScheduler, envBool, envInt, type Scheduler, leaderLockKey, DEFAULT_LEADER_LOCK_TTL_MS } from '@pipeline-builder/api-core';
import { runWithTenantContext } from '../database/tenancy.js';

const logger = createLogger('soft-delete-sweep');

/** The slice of a CrudService the sweep needs, plus a label for logs/metrics. */
export interface PurgeableEntity {
  /** Table/entity label (e.g. 'pipeline') for per-table logging. */
  name: string;
  /** Hard-delete up to `limit` expired tombstones; returns rows purged. */
  purgeExpired(now: Date, limit?: number): Promise<number>;
}

/**
 * The services that run a soft-delete purge. A closed union, not a `string`,
 * because the value becomes the LOCK KEY: two services passing the same string
 * would silently share one lock, and whichever lost it would simply never sweep —
 * a typo that stops a purge with no error anywhere.
 */
export type SoftDeleteSweepService = 'pipeline' | 'plugin' | 'message' | 'compliance' | 'platform';

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
  return envBool('SOFT_DELETE_PURGE_ENABLED', true);
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
  run?: { signal: AbortSignal },
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
      // Between entities: the leader lock was lost (another pod is taking over) or
      // we are shutting down. The remaining entities are picked up next tick —
      // their tombstones are still expired — and stopping lets the lock go.
      if (run?.signal.aborted) {
        logger.info('Soft-delete purge stopping early', { reason: String(run.signal.reason ?? 'aborted'), atEntity: entity.name });
        break;
      }
      let total = 0;
      for (let i = 0; i < maxBatches; i++) {
        // Also between BATCHES: one entity with a large backlog can run for many
        // batches, which is exactly the case a TTL used to have to cover.
        if (run?.signal.aborted) break;
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
  service: SoftDeleteSweepService;
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

  const intervalMs = envInt('SOFT_DELETE_PURGE_INTERVAL_HOURS', 6, { min: 1 }) * 60 * 60 * 1000;
  const startupDelayMs = envInt('SOFT_DELETE_PURGE_STARTUP_DELAY_MS', 120_000, { min: 0 });
  const lockTtlMs = envInt('SOFT_DELETE_PURGE_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1000 });

  logger.info('Soft-delete purge scheduler starting', {
    service: opts.service,
    entities: opts.entities.map((e) => e.name),
    intervalHours: intervalMs / 3_600_000,
  });

  return createScheduler({
    name: `soft-delete-purge:${opts.service}`,
    intervalMs,
    startupDelayMs,
    run: async (run) => { await runSoftDeletePurge(opts.entities, opts, run); },
    lock: { key: leaderLockKey(opts.service, 'soft-delete-purge'), ttlMs: lockTtlMs },
  });
}
