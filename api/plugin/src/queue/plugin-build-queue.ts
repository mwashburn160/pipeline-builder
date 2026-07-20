// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';

import { createLogger, decrementQuota, DEFAULT_TIER, errorMessage, extractDbError, getServiceAuthHeader, reserveQuota, VALID_TIERS } from '@pipeline-builder/api-core';
import type { QuotaService, QuotaTier } from '@pipeline-builder/api-core';
import { incCounter, observe } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import type { PluginBuildConfig } from '@pipeline-builder/pipeline-core';
import { Config, CoreConstants } from '@pipeline-builder/pipeline-core';
import { db, schema, reportingService, runWithTenantContext, withTenantTx } from '@pipeline-builder/pipeline-data';
import { Queue, Worker } from 'bullmq';
import type { Job, ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';

import {
  DLQ_NAME,
  getDeadLetterQueue,
  enforceDlqMaxSize,
  startDlqWorker,
  closeDlqWorker,
  closeDlqQueue,
} from './plugin-build-dlq.js';
import { startQueueMetricsScraper, stopQueueMetricsScraper } from './queue-metrics-scraper.js';
import { ORG_SLOT_DELAY_MS, tryAcquireOrgSlot, releaseOrgSlot, scrubOrgSlots } from './slot-manager.js';
import { getBuildStrategy } from '../helpers/build-strategy.js';
import { getBuildkitAddrForTier, BUILD_TEMP_ROOT } from '../helpers/docker-build.js';
import type { FailureCategory, PluginBuildJobData } from '../helpers/plugin-helpers.js';
import { getAuditClient } from '../services/audit.js';
import { pluginService } from '../services/plugin-service.js';

// Re-exported so existing `import { ... } from './plugin-build-queue.js'` sites
// keep resolving after the DLQ concern moved to its own module.
export { getDeadLetterQueue, purgeDlq, replayDlqJob } from './plugin-build-dlq.js';

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
const mainBudget = () => getBuildCfg().maxAttempts;
const dlqBudget = () => getBuildCfg().dlqMaxAttempts * getBuildCfg().maxAttempts;
export const totalAttemptBudget = () => mainBudget() + dlqBudget();

const COMPLETED_JOB_RETENTION_SECS = CoreConstants.PLUGIN_BUILD_COMPLETED_RETENTION_SECS;

/**
 * Parse a positive integer from an env var, falling back to `def` when the
 * value is unset, empty, non-numeric, or non-positive. Guards against a
 * typo'd/garbage env yielding `NaN` — which would otherwise silently break
 * dependent logic (e.g. a `NaN` cache TTL makes `expiresAt = NaN`, and
 * `NaN > Date.now()` is always false so the tier cache never hits; a `NaN`
 * Worker concurrency is likewise nonsensical). Kept local to the plugin
 * service to avoid a cross-package dependency.
 */
export function intFromEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Queue name & singleton state

const QUEUE_NAME = CoreConstants.PLUGIN_BUILD_QUEUE_NAME;

// ---------------------------------------------------------------------------
// Per-tier queue partitioning
// ---------------------------------------------------------------------------
//
// One BullMQ queue + Worker per quota tier; cross-tier scheduling is
// isolated so a Developer-tier burst can't block Pro/Team/Enterprise dispatch.
// The per-org semaphore above still enforces intra-tier fairness.
//
// Each tier gets a name suffixed with the tier, so queues are symmetric and
// self-describing.
const TIER_QUEUE_NAMES: Record<QuotaTier, string> = {
  developer: `${QUEUE_NAME}-developer`,
  pro: `${QUEUE_NAME}-pro`,
  team: `${QUEUE_NAME}-team`,
  enterprise: `${QUEUE_NAME}-enterprise`,
};

/**
 * Per-tier Redis DB partitioning. Defaults to db=0 for every tier; operators
 * worried about noisy-neighbor contention at the Redis level set distinct
 * REDIS_DB_<TIER> env vars (0-15). CLUSTER mode collapses everything to db=0
 * regardless.
 */
function getRedisDbForTier(tier: QuotaTier): number {
  const envName = `REDIS_DB_${tier.toUpperCase()}`;
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return 0;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 15) return 0;
  return parsed;
}

// One ioredis client per DB number, shared across Queue/Worker instances per
// BullMQ guidance. Constructed lazily on first use.
const connectionsByDb = new Map<number, Redis>();
const tierQueues = new Map<QuotaTier, Queue<PluginBuildJobData>>();
const tierWorkers = new Map<QuotaTier, Worker<PluginBuildJobData>>();

// ---------------------------------------------------------------------------
// Per-org tier cache
// ---------------------------------------------------------------------------

export const TIER_CACHE_TTL_MS = intFromEnv('PLUGIN_TIER_CACHE_TTL_MS', 300000);
const tierCache = new Map<string, { tier: QuotaTier; expiresAt: number }>();

/** Look up the org's tier with a short-TTL in-process cache. Falls open to
 *  DEFAULT_TIER (and caches the fallback) when the quota service is
 *  unreachable so a transient outage doesn't fail every build submission. */
export async function getOrgTier(quotaService: QuotaService, orgId: string, authHeader: string): Promise<QuotaTier> {
  const cached = tierCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  try {
    const tier = await quotaService.getTier(orgId, authHeader);
    tierCache.set(orgId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
    return tier;
  } catch (err) {
    logger.warn('Quota tier lookup failed; using default tier', { orgId, error: errorMessage(err) });
    tierCache.set(orgId, { tier: DEFAULT_TIER, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
    return DEFAULT_TIER;
  }
}

// The remote-audit client (pointed at platform's `/audit/events` ingest, where
// `plugin.build.*` events land) is the shared singleton from services/audit.ts,
// so build-worker and route-handler emissions go through one client.

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

export function getConnectionForDb(dbNum: number): Redis {
  let conn = connectionsByDb.get(dbNum);
  if (!conn) {
    const redis = Config.get('redis');
    const host = redis.host;
    const port = redis.port;

    conn = new Redis({
      host,
      port,
      db: dbNum,
      maxRetriesPerRequest: null, // Required by BullMQ
    });

    conn.on('connect', () => {
      logger.info('Redis connected', { host, port, db: dbNum });
    });
    conn.on('error', (err: Error) => {
      logger.error('Redis connection error', { error: err.message, host, port, db: dbNum });
    });
    conn.on('close', () => {
      logger.warn('Redis connection closed', { host, port, db: dbNum });
    });
    conn.on('reconnecting', () => {
      logger.info('Redis reconnecting', { host, port, db: dbNum });
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

function getConnectionForTier(tier: QuotaTier): Redis {
  return getConnectionForDb(getRedisDbForTier(tier));
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
        removeOnComplete: { age: COMPLETED_JOB_RETENTION_SECS },
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

/**
 * Re-reserve a `plugins` quota slot for a fresh build re-enqueue (DLQ replay or
 * failed-build retry). The source job already RELEASED its slot on terminal
 * failure, so a re-run must re-reserve one and hand ownership to the new job.
 *
 * Returns the `quotaReleased` flag for the NEW job: `false` when a slot was
 * reserved (new job owns it and will release it on its own terminal), `true`
 * when the org is at its plugin cap or the reservation call failed (the job
 * carries no slot, keeping accounting balanced with no double-credit). The
 * re-enqueue always proceeds — it's an explicit admin action.
 */
export async function reserveReplaySlot(quotaService: QuotaService, orgId: string, authHeader: string, jobId: string): Promise<boolean> {
  try {
    const reservation = await reserveQuota(quotaService, orgId, 'plugins', authHeader);
    if (reservation.exceeded) {
      logger.warn('Re-enqueue proceeding without a plugin-quota slot (org at cap)', { jobId, orgId });
      return true;
    }
    return false;
  } catch (err) {
    logger.warn('Re-enqueue quota reservation failed; proceeding without slot', { jobId, orgId, error: errorMessage(err) });
    return true;
  }
}

/**
 * Locate a FAILED build job by id across the per-tier queues. BullMQ job ids
 * are unique per queue, and the failed set is spread across every tier queue,
 * so we probe each queue and return the first job that both exists and is in
 * the `failed` state. Returns null if no failed job with that id is found.
 */
export async function findFailedJob(jobId: string): Promise<Job<PluginBuildJobData> | null> {
  for (const { queue } of getAllTierQueues()) {
    const job = await queue.getJob(jobId);
    if (job && await job.isFailed()) return job;
  }
  return null;
}

/**
 * Retry a single FAILED build by re-enqueuing its original job data onto the
 * build queue matching the org's tier. Resets retry counters so the retry gets
 * a fresh budget and removes the original failed entry after a successful
 * enqueue so it doesn't show up twice. Returns the new job id, or null when no
 * failed job with that id exists.
 *
 * This is the failed-build counterpart to `replayDlqJob` (which sources from
 * the dead-letter queue). Both funnel through the same enqueue path.
 */
export async function retryFailedJob(jobId: string, quotaService: QuotaService): Promise<string | null> {
  const failedJob = await findFailedJob(jobId);
  if (!failedJob) return null;

  const { orgId } = failedJob.data;
  const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });
  const quotaReleased = await reserveReplaySlot(quotaService, orgId, authHeader, jobId);

  const freshData: PluginBuildJobData = {
    ...failedJob.data,
    totalAttempts: 0,
    quotaReleased,
  };
  delete (freshData as { lastError?: string }).lastError;
  delete (freshData as { failureCategory?: string }).failureCategory;

  const tier = await getOrgTier(quotaService, orgId, authHeader);

  let requeued: Job<PluginBuildJobData>;
  try {
    requeued = await getTierQueue(tier).add(`retry-${failedJob.name}`, freshData);
  } catch (err) {
    // The enqueue failed *after* reserveReplaySlot handed the new job a quota
    // slot (quotaReleased === false means a slot was reserved). Nothing now
    // owns that slot, so release it here — mirroring releasePluginQuota's
    // decrement path — or it leaks until the quota period resets. When the org
    // was already at cap (quotaReleased === true) there is nothing to release.
    if (!quotaReleased) {
      decrementQuota(quotaService, orgId, 'plugins', authHeader, logger.warn.bind(logger));
    }
    logger.error('Failed-build retry enqueue failed; released reserved quota slot', {
      jobId, orgId, error: errorMessage(err),
    });
    throw err;
  }

  // The new job is enqueued and now owns the slot. Removing the original failed
  // entry is best-effort: a failure here must NOT error the whole op (the build
  // is already queued, and throwing would make an admin retry — enqueuing a
  // SECOND concurrent build, each holding a slot). But a lingering failed entry
  // could itself be retried again later → the same double-enqueue. So tolerate
  // an already-removed job (idempotent) and log loudly when one genuinely
  // lingers so it can be cleaned up manually.
  try {
    await failedJob.remove();
  } catch (removeErr) {
    const stillFailed = await failedJob.isFailed().catch(() => false);
    if (stillFailed) {
      logger.warn('Retry enqueued but original failed entry could not be removed; ' +
        'manual cleanup needed to avoid a duplicate retry', { jobId, orgId, newJobId: String(requeued.id), error: errorMessage(removeErr) });
    } else {
      logger.debug('Original failed job already removed after retry enqueue', { jobId });
    }
  }

  return String(requeued.id);
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

function classifyFailure(error: Error): FailureCategory {
  const msg = error.message;
  const dbCode = extractDbError(error)?.dbCode;

  if (dbCode === '42703' || dbCode === '42P01' || dbCode === '23505') return 'permanent';
  if (msg.includes('COMPLIANCE_VIOLATION') || msg.includes('VALIDATION_ERROR')) return 'permanent';
  if (msg.includes('missing image.tar') || msg.includes('Tarball not found')) return 'permanent';

  return 'retryable';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWorkerReady(): boolean {
  for (const tier of VALID_TIERS) {
    if (!tierWorkers.get(tier)) return false;
    const conn = connectionsByDb.get(getRedisDbForTier(tier));
    if (conn?.status !== 'ready') return false;
  }
  return true;
}

/**
 * Wait for every tier worker's Redis connection to become ready. Each tier
 * is awaited concurrently against a shared timeout budget; rejects with the
 * first unmet tier (or a combined timeout) so a stuck Redis on one tier
 * fails fast instead of hanging behind a single-tier check.
 */
export function waitForWorkerReady(timeoutMs = getBuildCfg().workerTimeoutMs): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isWorkerReady()) return resolve();

    const waiters = VALID_TIERS.map((tier) => new Promise<void>((res, rej) => {
      const worker = tierWorkers.get(tier);
      if (!worker) return rej(new Error(`Worker for tier ${tier} not started`));
      const conn = connectionsByDb.get(getRedisDbForTier(tier));
      if (conn?.status === 'ready') return res();
      const onReady = () => res();
      const timer = setTimeout(() => {
        worker.off('ready', onReady);
        rej(new Error(`Worker for tier ${tier} not ready after ${timeoutMs}ms`));
      }, timeoutMs);
      worker.on('ready', () => { clearTimeout(timer); onReady(); });
    }));

    Promise.all(waiters).then(() => resolve(), (err) => reject(err));
  });
}

export function cleanupContextDir(dir: string): void {
  if (dir && fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.debug('Temp dir cleanup failed', { path: dir, error: errorMessage(err) });
    }
  }
}

/**
 * Persist a plugin build event then invalidate the org's reporting cache.
 *
 * Order matters: invalidate ONLY after the insert resolves so a failed
 * insert never wipes a still-fresh cache.
 */
function recordBuildEvent(orgId: string, status: 'completed' | 'failed', job: Job, detail: Record<string, unknown>): void {
  const startedMs = job.processedOn ?? job.timestamp;
  const completedMs = job.finishedOn ?? Date.now();
  const durationMs = startedMs ? completedMs - startedMs : undefined;

  if (!db?.insert) return;

  withTenantTx((tx) => tx.insert(schema.pipelineEvent)
    .values({
      orgId,
      eventSource: 'plugin-build',
      eventType: 'BUILD',
      status,
      executionId: job.id ?? undefined,
      errorMessage: status === 'failed' ? (detail.errorMessage as string) : undefined,
      startedAt: startedMs ? new Date(startedMs) : undefined,
      completedAt: new Date(completedMs),
      durationMs,
      detail: {
        ...detail,
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      },
    })
    // BullMQ may re-run a job (retry/stalled-recovery) and re-record the same
    // (execution_id=jobId) BUILD event; dedup on the event_dedup_idx instead of
    // inserting duplicate rows that inflate build metrics.
    .onConflictDoNothing())
    .then(
      () => reportingService.invalidateOrg(orgId).catch((invalidateErr: unknown) => {
        logger.warn('Reporting cache invalidation failed after build event', { orgId, error: errorMessage(invalidateErr) });
      }),
      (insertErr: unknown) => {
        logger.warn('Failed to record build event', { error: errorMessage(insertErr) });
      },
    );
}

/**
 * Collect context dirs referenced by jobs across main queue and DLQ.
 * Includes failed state to protect dirs during DLQ backoff.
 */
async function getProtectedContextDirs(): Promise<Set<string>> {
  const dirs = new Set<string>();
  const states = ['waiting', 'delayed', 'active', 'failed'] as const;
  try {
    const tierJobLists = await Promise.all([
      ...getAllTierQueues().map(({ queue }) => queue.getJobs([...states])),
      getDeadLetterQueue().getJobs([...states]),
    ]);
    for (const jobs of tierJobLists) {
      for (const job of jobs) {
        const dir = job.data?.buildRequest?.contextDir;
        if (dir) dirs.add(dir);
      }
    }
  } catch { /* best-effort */ }
  return dirs;
}

/**
 * Release the org's reserved `plugins` quota slot for a build job exactly once.
 * Every terminal failure path (main worker + DLQ worker) and every DLQ purge
 * funnels through here. The `quotaReleased` flag — mutated in-memory for same-tick
 * idempotency and persisted via `updateData` so a freshly-fetched job in a later
 * purge sees it — guarantees a job that already gave its slot back on exhaustion
 * isn't decremented again when a purge removes it (double-count), while a job
 * purged before it ever reached a terminal handler still gets its slot back.
 */
export function releasePluginQuota(job: Job<PluginBuildJobData>, quotaService: QuotaService): void {
  if (job.data.quotaReleased) return;
  const { orgId } = job.data;
  decrementQuota(quotaService, orgId, 'plugins',
    getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }),
    logger.warn.bind(logger),
  );
  job.data.quotaReleased = true;
  void job.updateData(job.data).catch((err) =>
    logger.debug('Failed to persist quotaReleased flag', { jobId: job.id, error: String(err) }),
  );
}

// ---------------------------------------------------------------------------
// Main worker
// ---------------------------------------------------------------------------

export function startWorker(sseManager: SSEManager, quotaService: QuotaService): void {
  if (tierWorkers.size > 0) return;

  const { concurrency } = getBuildCfg();
  const tierConcurrency: Record<QuotaTier, number> = {
    developer: intFromEnv('PLUGIN_BUILD_CONCURRENCY_DEVELOPER', concurrency),
    pro: intFromEnv('PLUGIN_BUILD_CONCURRENCY_PRO', concurrency),
    team: intFromEnv('PLUGIN_BUILD_CONCURRENCY_TEAM', concurrency),
    enterprise: intFromEnv('PLUGIN_BUILD_CONCURRENCY_ENTERPRISE', concurrency),
  };

  const processor = async (job: Job<PluginBuildJobData>, token?: string) => {
    const { requestId, orgId, userId, buildRequest, pluginRecord } = job.data;

    return runWithTenantContext({ orgId, isSuperAdmin: false }, async () => {
      const slotJobId = String(job.id ?? job.name);
      if (!await tryAcquireOrgSlot(orgId, slotJobId)) {
        await job.moveToDelayed(Date.now() + ORG_SLOT_DELAY_MS, token);
        throw Worker.RateLimitError();
      }
      try {
        if (job.timestamp) {
          observe('plugin_job_wait_seconds', {}, (Date.now() - job.timestamp) / 1000);
        }

        sseManager.send(requestId, 'INFO', 'Build started', {
          jobId: job.id,
          plugin: `${pluginRecord.name}:${pluginRecord.version}`,
        });

        try { fs.utimesSync(buildRequest.contextDir, new Date(), new Date()); } catch { /* ignore */ }

        const isApprovalStep = pluginRecord.pluginType === 'ManualApprovalStep';
        let fullImage = '';

        const strategy = getBuildStrategy(buildRequest.buildType);
        // isApprovalStep is a second, orthogonal "skip build" axis (pluginType), kept here.
        if (!isApprovalStep && strategy.producesImage) {
          const result = await strategy.produceImage(buildRequest, {
            // Lazy: only build_image awaits this, so prebuilt skips the tier/quota lookup.
            getBuildkitAddr: async () => getBuildkitAddrForTier(
              await getOrgTier(quotaService, orgId, getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }))),
          });
          fullImage = result.fullImage;
          sseManager.send(requestId, 'INFO', 'Image pushed', { fullImage });
        }

        const result = await pluginService.deployVersion(pluginRecord, userId);

        recordBuildEvent(orgId, 'completed', job, {
          pluginName: result.name,
          pluginVersion: result.version,
          pluginId: result.id,
        });

        // job.finishedOn isn't set until the processor returns, so it's always
        // undefined here — use Date.now(), matching recordBuildEvent's fallback.
        const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
        logger.info('Plugin build event', {
          eventCategory: 'plugin-build',
          action: 'plugin.build.completed',
          event: 'completed',
          actorId: userId,
          orgId,
          targetType: 'plugin',
          targetId: result.id,
          pluginName: result.name,
          pluginVersion: result.version,
          jobId: job.id,
          durationMs,
        });

        getAuditClient().record({
          action: 'plugin.build.completed',
          actorId: userId,
          orgId,
          targetType: 'plugin',
          targetId: result.id,
          details: {
            pluginName: result.name,
            pluginVersion: result.version,
            jobId: job.id,
            durationMs,
          },
        }, 'plugin');

        sseManager.send(requestId, 'COMPLETED', 'Plugin deployed', {
          id: result.id,
          name: result.name,
          version: result.version,
          fullImage,
        });

        cleanupContextDir(buildRequest.contextDir);

        return { pluginId: result.id, fullImage };
      } finally {
        await releaseOrgSlot(orgId, slotJobId);
      }
    });
  };

  // -- Error handling -------------------------------------------------------

  const failedHandler = (job: Job<PluginBuildJobData> | undefined, error: Error) => {
    if (!job) return;

    // The 'failed' event fires OUTSIDE the processor's runWithTenantContext, so
    // recordBuildEvent's withTenantTx insert would run with an empty
    // `app.org_id` and RLS silently drops the failed BUILD row (the insert's
    // .catch just logs a warn). Re-establish the job's tenant scope for the
    // whole handler so the failure is recorded (and any other tenant-scoped
    // read/write here is attributable).
    return runWithTenantContext({ orgId: job.data.orgId, isSuperAdmin: false }, async () => {
      const { requestId, orgId, pluginRecord, buildRequest } = job.data;
      const totalAttempts = (job.data.totalAttempts ?? 0) + 1;
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade >= maxAttempts;

      // Prometheus counter. `plugin_name` is intentionally omitted to keep the
      // label set bounded -- per-plugin drill-down is served via Loki.
      const isTimeout = /timed out|timeout/i.test(error.message);
      incCounter('plugin_builds_total', {
        status: isTimeout ? 'timeout' : 'failed',
        org_id: orgId ?? 'unknown',
      });

      logger.error('Plugin build failed', {
        jobId: job.id,
        requestId,
        error: error.message,
        attemptsMade: job.attemptsMade,
        totalAttempts,
        isFinalAttempt,
        ...extractDbError(error),
      });

      sseManager.send(requestId, 'ERROR', 'Build failed: an error occurred during the build process', {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        maxAttempts,
      });

      recordBuildEvent(orgId, 'failed', job, {
        pluginName: pluginRecord.name,
        pluginVersion: pluginRecord.version,
        errorMessage: error.message,
      });

      const action = isTimeout ? 'plugin.build.timeout' : 'plugin.build.failed';
      logger.info('Plugin build event', {
        eventCategory: 'plugin-build',
        action,
        event: isTimeout ? 'timeout' : 'failed',
        actorId: job.data.userId,
        orgId,
        targetType: 'plugin',
        pluginName: pluginRecord.name,
        pluginVersion: pluginRecord.version,
        jobId: job.id,
        errorMessage: error.message,
      });

      if (isFinalAttempt) {
        getAuditClient().record({
          action,
          actorId: job.data.userId,
          orgId,
          targetType: 'plugin',
          details: {
            pluginName: pluginRecord.name,
            pluginVersion: pluginRecord.version,
            jobId: job.id,
            errorMessage: error.message,
            isTimeout,
          },
        }, 'plugin');
      }

      if (!isFinalAttempt) return;

      const category = classifyFailure(error);
      const cfg = getBuildCfg();
      const budget = totalAttemptBudget();

      // Permanent failure: terminal. Decrement here because the job will not
      // reach the DLQ. When the failure IS retryable (DLQ-bound branch below),
      // we deliberately skip decrement -- the dlqWorker's `failed` handler
      // owns the decrement on DLQ exhaustion, otherwise a single retryable
      // failure would double-count.
      if (category === 'permanent' || totalAttempts >= budget) {
        cleanupContextDir(buildRequest.contextDir);
        releasePluginQuota(job, quotaService);
        logger.warn('Permanent failure, cleaned up', {
          jobId: job.id,
          pluginName: pluginRecord.name,
          category,
          totalAttempts,
        });
        return;
      }

      // Retryable: move to DLQ for retry (keep dir alive; do NOT decrement
      // quota -- the DLQ exhaustion path owns that decrement).
      const dlqData: PluginBuildJobData = {
        ...job.data,
        failureCategory: category,
        lastError: error.message,
        totalAttempts,
      };

      enforceDlqMaxSize(quotaService)
        .then(() => getDeadLetterQueue().add(`dlq-${job.id}`, dlqData, {
          jobId: `dlq-${job.id}`,
          attempts: cfg.dlqMaxAttempts,
          backoff: { type: 'exponential', delay: cfg.dlqBackoffBaseMs },
        }))
        .then(() => {
          logger.info('Moved to DLQ for retry', {
            jobId: job.id,
            pluginName: pluginRecord.name,
            totalAttempts,
            dlqAttempts: cfg.dlqMaxAttempts,
          });
        })
        .catch((dlqErr) => {
          logger.warn('Failed to move job to DLQ, cleaning up', { jobId: job.id, error: errorMessage(dlqErr) });
          cleanupContextDir(buildRequest.contextDir);
        });
    });
  };

  const errorHandler = (error: Error) => {
    logger.error('Worker error', { error: error.message });
  };

  const completedHandler = (job: Job<PluginBuildJobData>) => {
    const orgId = job.data?.orgId ?? 'unknown';
    incCounter('plugin_builds_total', { status: 'success', org_id: orgId });
    if (job.processedOn && job.finishedOn) {
      observe('plugin_build_duration_seconds',
        { org_id: orgId },
        (job.finishedOn - job.processedOn) / 1000,
      );
    }
    logger.info('Plugin build completed', { jobId: job.id, name: job.name });
  };

  for (const tier of VALID_TIERS) {
    const tierQueue = getTierQueue(tier);
    const tierWorker = new Worker<PluginBuildJobData>(tierQueue.name, processor, {
      connection: getConnectionForTier(tier) as ConnectionOptions,
      concurrency: tierConcurrency[tier],
    });

    tierWorker.on('failed', failedHandler);
    tierWorker.on('error', errorHandler);
    tierWorker.on('completed', completedHandler);
    tierWorker.on('ready', () => {
      logger.info('Plugin build worker ready (Redis connected)', { tier, concurrency: tierConcurrency[tier] });
    });

    tierWorkers.set(tier, tierWorker);
  }

  logger.info('Plugin build workers started', { tierConcurrency });

  startDlqWorker(quotaService);
  startTempCleanup();
  // Reconcile any slot leaked across the previous process lifetime on boot,
  // and then again on every periodic temp-cleanup tick. Fire-and-forget —
  // errors are logged inside scrubOrgSlots; we don't block startup on it.
  void scrubOrgSlots();
  startQueueMetricsScraper([
    ...getAllTierQueues().map(({ queue }) => ({ name: queue.name, queue })),
    { name: DLQ_NAME, queue: getDeadLetterQueue() },
  ]);
}

// ---------------------------------------------------------------------------
// Periodic temp directory cleanup + slot scrub
// ---------------------------------------------------------------------------

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function cleanupStaleTempDirs(): void {
  const tmpRoot = BUILD_TEMP_ROOT;
  if (!fs.existsSync(tmpRoot)) return;

  // Piggy-back on the cleanup tick to scrub leaked org slots; both walk
  // the live BullMQ state so co-locating amortises the queue reads.
  // Fire-and-forget — errors are logged inside scrubOrgSlots.
  void scrubOrgSlots();

  getProtectedContextDirs().then((protectedDirs) => {
    const maxAgeMs = getBuildCfg().tempDirMaxAgeMs;
    try {
      const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(tmpRoot, entry.name);
        if (protectedDirs.has(dirPath)) continue;
        try {
          const stat = fs.statSync(dirPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            logger.debug('Cleaned up stale temp dir', { path: dirPath });
          }
        } catch (err) {
          logger.debug('Failed to clean temp dir', { path: dirPath, error: errorMessage(err) });
        }
      }
    } catch (err) {
      logger.debug('Temp dir cleanup scan failed', { error: errorMessage(err) });
    }
  }).catch(() => {});
}

function startTempCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupStaleTempDirs, getBuildCfg().tempDirMaxAgeMs);
  cleanupTimer.unref();
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export async function shutdownQueue(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  stopQueueMetricsScraper();
  await closeDlqWorker();
  await Promise.all(Array.from(tierWorkers.values()).map((w) => w.close()));
  tierWorkers.clear();
  await Promise.all(Array.from(tierQueues.values()).map((q) => q.close()));
  tierQueues.clear();
  await closeDlqQueue();
  for (const conn of connectionsByDb.values()) {
    conn.disconnect();
  }
  connectionsByDb.clear();
  tierCache.clear();
  logger.info('Plugin build queue shut down');
}
