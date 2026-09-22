// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Redis connections and BullMQ queue HANDLES for the plugin build pipeline:
 * the per-tier build queues, the dead-letter queue, the per-org tier cache, and
 * the lookups built on them.
 *
 * A leaf of the queue module graph — it creates no workers and imports no other
 * queue module — so the worker (plugin-build-queue), the failure handler, the
 * DLQ worker, the requeue helpers and the slot manager can all depend on it
 * without an import cycle.
 */

import { CacheService, envInt, createLogger, createRedisClient, DEFAULT_TIER, describeRedisConnection, errorMessage, resolveRedisConnection, VALID_TIERS } from '@pipeline-builder/api-core';
import type { QuotaService, QuotaTier } from '@pipeline-builder/api-core';
import type { PluginBuildConfig } from '@pipeline-builder/pipeline-core';
import { Config, CoreConstants } from '@pipeline-builder/pipeline-core';
import { Queue } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import type { Redis } from 'ioredis';

import type { PluginBuildJobData } from '../helpers/plugin-helpers.js';

const logger = createLogger('plugin-build-queue');

/** Lazy accessor so config load errors surface on use, not at module import. */
export function getBuildCfg(): PluginBuildConfig {
  return Config.get('pluginBuild');
}

/**
 * Total attempt budget across main + DLQ before a job is treated as permanent.
 * The main queue retries `maxAttempts` times, then each DLQ retry re-enters
 * the main queue and burns another `maxAttempts`: `mainBudget + dlqBudget`.
 */
export const totalAttemptBudget = (): number => {
  const cfg = getBuildCfg();
  return cfg.maxAttempts + cfg.dlqMaxAttempts * cfg.maxAttempts;
};

const QUEUE_NAME = CoreConstants.PLUGIN_BUILD_QUEUE_NAME;
export const DLQ_NAME = `${QUEUE_NAME}-dlq`;

// ---------------------------------------------------------------------------
// Per-tier queue partitioning
// ---------------------------------------------------------------------------
//
// One BullMQ queue + Worker per quota tier; cross-tier scheduling is isolated so
// a Developer-tier burst can't block Pro/Team/Enterprise dispatch. The per-org
// semaphore (slot-manager) still enforces intra-tier fairness. Each tier gets a
// name suffixed with the tier, so queues are symmetric and self-describing.
const TIER_QUEUE_NAMES: Record<QuotaTier, string> = {
  developer: `${QUEUE_NAME}-developer`,
  pro: `${QUEUE_NAME}-pro`,
  team: `${QUEUE_NAME}-team`,
  enterprise: `${QUEUE_NAME}-enterprise`,
  // Billing-disabled default tier: its own queue (all orgs land here when billing is off).
  unlimited: `${QUEUE_NAME}-unlimited`,
};

/**
 * Per-tier Redis DB partitioning. Defaults to db=0 for every tier; operators
 * worried about noisy-neighbor contention at the Redis level set distinct
 * REDIS_DB_<TIER> env vars (0-15). CLUSTER mode collapses everything to db=0
 * regardless.
 */
function getRedisDbForTier(tier: QuotaTier): number {
  const raw = process.env[`REDIS_DB_${tier.toUpperCase()}`];
  if (raw === undefined || raw === '') return 0;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 15) return 0;
  return parsed;
}

// One ioredis client per DB number, shared across Queue/Worker instances per
// BullMQ guidance. Constructed lazily on first use.
const connectionsByDb = new Map<number, Redis>();
const tierQueues = new Map<QuotaTier, Queue<PluginBuildJobData>>();
let dlq: Queue<PluginBuildJobData> | null = null;

// ---------------------------------------------------------------------------
// Redis connections
// ---------------------------------------------------------------------------

export function getConnectionForDb(dbNum: number): Redis {
  let conn = connectionsByDb.get(dbNum);
  if (!conn) {
    // Same resolution as every other Redis client (REDIS_URL or REDIS_SENTINELS;
    // see api-core env-redis). Sentinel mode follows the master across a
    // failover. Builds can't run without Redis, so no configuration is an error.
    const resolved = resolveRedisConnection();
    if (!resolved) {
      throw new Error('Plugin builds need Redis: set REDIS_URL or REDIS_SENTINELS');
    }
    const logCtx = { ...describeRedisConnection(resolved), db: dbNum };
    conn = createRedisClient<Redis>(resolved, `plugin-build-queue-db${dbNum}`, {
      db: dbNum,
      maxRetriesPerRequest: null, // Required by BullMQ
    });

    conn.on('connect', () => {
      logger.info('Redis connected', logCtx);
    });
    conn.on('close', () => {
      logger.warn('Redis connection closed', logCtx);
    });
    conn.on('reconnecting', () => {
      logger.info('Redis reconnecting', logCtx);
    });

    connectionsByDb.set(dbNum, conn);
  }
  return conn;
}

/**
 * ioredis connection (db 0) for the service's readiness probe — reuses the
 * same pooled connection the build queue uses, so `/ready` reflects the real
 * redis the plugin service depends on rather than opening a throwaway client.
 */
export function getHealthRedisConnection(): Redis {
  return getConnectionForDb(0);
}

export function getConnectionForTier(tier: QuotaTier): Redis {
  return getConnectionForDb(getRedisDbForTier(tier));
}

/** True when the (already-created) Redis connection backing `tier` is ready. */
export function isTierConnectionReady(tier: QuotaTier): boolean {
  return connectionsByDb.get(getRedisDbForTier(tier))?.status === 'ready';
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

export function getTierQueue(tier: QuotaTier): Queue<PluginBuildJobData> {
  let q = tierQueues.get(tier);
  if (!q) {
    const cfg = getBuildCfg();
    q = new Queue<PluginBuildJobData>(TIER_QUEUE_NAMES[tier], {
      connection: getConnectionForTier(tier) as ConnectionOptions,
      defaultJobOptions: {
        attempts: cfg.maxAttempts,
        backoff: { type: 'exponential', delay: cfg.backoffDelayMs },
        removeOnComplete: { age: CoreConstants.PLUGIN_BUILD_COMPLETED_RETENTION_SECS },
        removeOnFail: { age: CoreConstants.PLUGIN_BUILD_FAILED_RETENTION_SECS },
      },
    });
    tierQueues.set(tier, q);
  }
  return q;
}

export function getAllTierQueues(): Array<{ tier: QuotaTier; queue: Queue<PluginBuildJobData> }> {
  return VALID_TIERS.map((tier) => ({ tier, queue: getTierQueue(tier) }));
}

export async function enqueueBuild(tier: QuotaTier, jobName: string, jobData: PluginBuildJobData): Promise<void> {
  await getTierQueue(tier).add(jobName, jobData);
}

export function getDeadLetterQueue(): Queue<PluginBuildJobData> {
  if (!dlq) {
    dlq = new Queue<PluginBuildJobData>(DLQ_NAME, {
      connection: getConnectionForDb(0) as ConnectionOptions,
      defaultJobOptions: {
        // BOUNDED (was `false`): a DLQ job that re-queues on its first attempt
        // COMPLETES with attemptsMade < maxAttempts. `enforceDlqMaxSize` evicts
        // these explicitly (as `already-requeued`, without releasing the slot or
        // artifacts the new main-queue job owns), but this cap is still the
        // backstop that keeps the retained-completed set from growing
        // unboundedly in Redis between enforcement passes.
        removeOnComplete: { count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return dlq;
}

/**
 * The DLQ job id for a build job.
 *
 * QUEUE-QUALIFIED, for the same reason the slot owner id is: BullMQ ids are
 * monotonic PER QUEUE, so the per-tier queues mint colliding ids. A bare
 * `dlq-${job.id}` meant a retryable failure of job `7` in the `pro` queue hit
 * the `dlq-7` already retained from the `developer` queue — and BullMQ treats
 * an add with a duplicate custom id as a NO-OP, so the DLQ entry was never
 * created, the org's `plugins` slot leaked until period reset, and the build
 * vanished. The same collision made `findFailedJob` / the manual-retry DLQ-twin
 * guard resolve another tier's job.
 */
export function dlqJobId(queueName: string, jobId: string): string {
  return `dlq-${queueName}:${jobId}`;
}

/**
 * Locate a FAILED build job by id across the per-tier queues. The failed set is
 * spread across every tier queue, so probe each and return the first job that
 * both exists and is in the `failed` state; null when none is found.
 */
export async function findFailedJob(jobId: string): Promise<Job<PluginBuildJobData> | null> {
  for (const { queue } of getAllTierQueues()) {
    const job = await queue.getJob(jobId);
    if (job && await job.isFailed()) return job;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-org tier cache
// ---------------------------------------------------------------------------

export const TIER_CACHE_TTL_MS = envInt('PLUGIN_TIER_CACHE_TTL_MS', 300000, { min: 1 });
// Bounded (LRU) and process-local: a stale tier only routes a build to a
// neighbouring queue until the TTL, so no cross-replica invalidation is needed.
const tierCache = new CacheService({ prefix: 'plugin-tier:', defaultTtlSeconds: TIER_CACHE_TTL_MS / 1000, maxEntries: 5_000, invalidationBus: null });

/** Look up the org's tier with a short-TTL in-process cache. Falls open to
 *  DEFAULT_TIER (and caches the fallback) when the quota service is
 *  unreachable so a transient outage doesn't fail every build submission. */
export async function getOrgTier(quotaService: QuotaService, orgId: string, authHeader: string): Promise<QuotaTier> {
  const cached = await tierCache.get<QuotaTier>(orgId);
  if (cached) return cached;

  let tier: QuotaTier;
  try {
    tier = await quotaService.getTier(orgId, authHeader);
  } catch (err) {
    logger.warn('Quota tier lookup failed; using default tier', { orgId, error: errorMessage(err) });
    tier = DEFAULT_TIER;
  }
  await tierCache.set(orgId, tier);
  return tier;
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Close every queue handle (tier queues, then the DLQ), disconnect the Redis
 * connections and drop the tier cache. Call AFTER the workers are closed.
 */
export async function closeQueuesAndConnections(): Promise<void> {
  await Promise.all(Array.from(tierQueues.values()).map((q) => q.close()));
  tierQueues.clear();
  if (dlq) {
    await dlq.close();
    dlq = null;
  }
  for (const conn of connectionsByDb.values()) {
    conn.disconnect();
  }
  connectionsByDb.clear();
  await tierCache.clear();
}
