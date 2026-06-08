// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';

import { createLogger, createRemoteAuditClient, decrementQuota, DEFAULT_TIER, errorMessage, extractDbError, getServiceAuthHeader, VALID_TIERS } from '@pipeline-builder/api-core';
import type { QuotaService, QuotaTier, RemoteAuditClient } from '@pipeline-builder/api-core';
import { incCounter, observe } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import type { PluginBuildConfig } from '@pipeline-builder/pipeline-core';
import { Config, CoreConstants, db, schema, reportingService, runWithTenantContext, withTenantTx } from '@pipeline-builder/pipeline-core';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import { startQueueMetricsScraper, stopQueueMetricsScraper } from './queue-metrics-scraper';
import { buildAndPush, getBuildkitAddrForTier, loadAndPush, BUILD_TEMP_ROOT } from '../helpers/docker-build';
import type { FailureCategory, PluginBuildJobData } from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';

const logger = createLogger('plugin-build-queue');

/** Lazy accessor so config load errors surface on use, not at module import. */
function getBuildCfg(): PluginBuildConfig {
  return Config.get('pluginBuild');
}

/**
 * Total attempt budget across main + DLQ before a job is treated as permanent.
 * The main queue retries `maxAttempts` times, then each DLQ retry re-enters
 * the main queue and burns another `maxAttempts`: `mainBudget + dlqBudget`.
 */
const mainBudget = () => getBuildCfg().maxAttempts;
const dlqBudget = () => getBuildCfg().dlqMaxAttempts * getBuildCfg().maxAttempts;
const totalAttemptBudget = () => mainBudget() + dlqBudget();

const COMPLETED_JOB_RETENTION_SECS = CoreConstants.PLUGIN_BUILD_COMPLETED_RETENTION_SECS;

// ---------------------------------------------------------------------------
// Per-org concurrency cap (multi-tenancy hardening)
// ---------------------------------------------------------------------------
//
// BullMQ OSS doesn't have built-in group-keyed concurrency; we layer a
// per-org semaphore on top of Redis. Each worker tries to acquire a slot
// before processing; over the cap it re-enqueues with a short delay so
// another org's job can take the worker slot. Atomic via Lua so two
// concurrent acquires can't both observe a stale count and over-allocate.
//
// Tuning:
//   PLUGIN_MAX_BUILDS_PER_ORG  max in-flight builds per org (default 3)
//   PLUGIN_ORG_SLOT_DELAY_MS   backoff between re-acquisition tries (default 10s)
//   ORG_SLOT_TTL_SEC           defensive expiry so a crashed worker doesn't leak
const MAX_BUILDS_PER_ORG = parseInt(process.env.PLUGIN_MAX_BUILDS_PER_ORG || '3', 10);
const ORG_SLOT_DELAY_MS = parseInt(process.env.PLUGIN_ORG_SLOT_DELAY_MS || '10000', 10);
const ORG_SLOT_TTL_SEC = parseInt(process.env.PLUGIN_ORG_SLOT_TTL_SEC || '900', 10);
const orgSlotKey = (orgId: string) => `pb:org-build:${orgId}`;
/** Sibling hash `jobId -> orgId` for live slot owners. The scrubber walks
 *  this to reconcile slots that BullMQ no longer knows about. */
const orgSlotOwnersKey = 'pb:org-build-owners';

/**
 * Atomic check-and-increment via Lua. Returns 1 if a slot was reserved
 * (count <= cap), 0 if the cap was already reached. Avoids the INCR-then-DECR
 * race where two acquires can briefly observe a count over the cap before one
 * rolls back.
 */
const ACQUIRE_SLOT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`;

/** Try to acquire an in-flight build slot for `orgId`. Returns true on success;
 *  false if the org is already at its cap (caller should re-enqueue). Records
 *  `jobId -> orgId` so the scrubber can reclaim a slot whose job vanished. */
async function tryAcquireOrgSlot(orgId: string, jobId: string): Promise<boolean> {
  const redis = getConnectionForDb(0);
  const result = await redis.eval(
    ACQUIRE_SLOT_LUA, 1, orgSlotKey(orgId),
    String(MAX_BUILDS_PER_ORG), String(ORG_SLOT_TTL_SEC),
  );
  if (result !== 1) return false;
  await redis.hset(orgSlotOwnersKey, jobId, orgId);
  return true;
}

/** Release the org's slot. Defensive: never let the counter go negative. */
async function releaseOrgSlot(orgId: string, jobId: string): Promise<void> {
  const redis = getConnectionForDb(0);
  const count = await redis.decr(orgSlotKey(orgId));
  if (count < 0) await redis.set(orgSlotKey(orgId), '0', 'EX', ORG_SLOT_TTL_SEC);
  await redis.hdel(orgSlotOwnersKey, jobId);
}

/**
 * Reconcile slot counters against live BullMQ state. For each owner entry
 * whose jobId is no longer in any active/waiting/delayed set across the tier
 * queues and DLQ, decrement the org's counter and drop the owner record.
 * Protects against worker crashes that leak slots until TTL expiry.
 */
async function scrubOrgSlots(): Promise<void> {
  const redis = getConnectionForDb(0);
  try {
    const owners = await redis.hgetall(orgSlotOwnersKey);
    const ownerEntries = Object.entries(owners);
    if (ownerEntries.length === 0) return;

    const activeStates = ['active', 'waiting', 'delayed'] as const;
    const tierJobLists = await Promise.all([
      ...getAllTierQueues().map(({ queue }) => queue.getJobs([...activeStates])),
      getDeadLetterQueue().getJobs([...activeStates]),
    ]);
    const liveJobIds = new Set<string>();
    for (const jobs of tierJobLists) for (const j of jobs) if (j.id) liveJobIds.add(String(j.id));

    for (const [jobId, orgId] of ownerEntries) {
      if (liveJobIds.has(jobId)) continue;
      const count = await redis.decr(orgSlotKey(orgId));
      if (count < 0) await redis.set(orgSlotKey(orgId), '0', 'EX', ORG_SLOT_TTL_SEC);
      await redis.hdel(orgSlotOwnersKey, jobId);
      logger.warn('Reclaimed leaked org build slot', { jobId, orgId });
    }
  } catch (err) {
    logger.debug('Org slot scrub failed', { error: errorMessage(err) });
  }
}

// Queue name & singleton state

const QUEUE_NAME = CoreConstants.PLUGIN_BUILD_QUEUE_NAME;
const DLQ_NAME = `${QUEUE_NAME}-dlq`;

// ---------------------------------------------------------------------------
// Per-tier queue partitioning
// ---------------------------------------------------------------------------
//
// One BullMQ queue + Worker per quota tier; cross-tier scheduling is
// isolated so a Developer-tier burst can't block Pro/Unlimited dispatch.
// The per-org semaphore above still enforces intra-tier fairness.
//
// Each tier gets a name suffixed with the tier, so queues are symmetric and
// self-describing.
const TIER_QUEUE_NAMES: Record<QuotaTier, string> = {
  developer: `${QUEUE_NAME}-developer`,
  pro: `${QUEUE_NAME}-pro`,
  unlimited: `${QUEUE_NAME}-unlimited`,
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
const connectionsByDb = new Map<number, IORedis>();
const tierQueues = new Map<QuotaTier, Queue<PluginBuildJobData>>();
const tierWorkers = new Map<QuotaTier, Worker<PluginBuildJobData>>();
let dlq: Queue<PluginBuildJobData> | null = null;
let dlqWorker: Worker<PluginBuildJobData> | null = null;

// ---------------------------------------------------------------------------
// Per-org tier cache
// ---------------------------------------------------------------------------

const TIER_CACHE_TTL_MS = parseInt(process.env.PLUGIN_TIER_CACHE_TTL_MS || '300000', 10);
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

/**
 * Lazily-constructed remote-audit client pointed at the platform's
 * `/audit/events` ingest endpoint so `plugin.build.*` events land in the
 * MongoDB audit log alongside platform-emitted actions.
 */
let auditClient: RemoteAuditClient | null = null;
function getAuditClient(): RemoteAuditClient {
  if (!auditClient) auditClient = createRemoteAuditClient();
  return auditClient;
}

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

function getConnectionForDb(dbNum: number): IORedis {
  let conn = connectionsByDb.get(dbNum);
  if (!conn) {
    const redis = Config.get('redis');
    const host = redis.host;
    const port = redis.port;

    conn = new IORedis({
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

function getConnectionForTier(tier: QuotaTier): IORedis {
  return getConnectionForDb(getRedisDbForTier(tier));
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

export function getDeadLetterQueue(): Queue<PluginBuildJobData> {
  if (!dlq) {
    dlq = new Queue<PluginBuildJobData>(DLQ_NAME, {
      connection: getConnectionForDb(0),
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
  }
  return dlq;
}

export function getTierQueue(tier: QuotaTier): Queue<PluginBuildJobData> {
  let q = tierQueues.get(tier);
  if (!q) {
    const cfg = getBuildCfg();
    q = new Queue<PluginBuildJobData>(TIER_QUEUE_NAMES[tier], {
      connection: getConnectionForTier(tier),
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

function cleanupContextDir(dir: string): void {
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
    }))
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

const DLQ_ENFORCE_SCAN_INTERVAL_MS = parseInt(process.env.PLUGIN_DLQ_SCAN_INTERVAL_MS || '5000', 10);
let lastDlqEnforceMs = 0;

/**
 * Enforce DLQ max size by purging oldest terminal jobs first. Rate-limited
 * to once per DLQ_ENFORCE_SCAN_INTERVAL_MS and gated by a cheap getJobCounts
 * total-check so the expensive scan only runs when the queue is close to its
 * cap.
 */
async function enforceDlqMaxSize(): Promise<void> {
  const now = Date.now();
  if (now - lastDlqEnforceMs < DLQ_ENFORCE_SCAN_INTERVAL_MS) return;
  lastDlqEnforceMs = now;

  const cfg = getBuildCfg();
  const q = getDeadLetterQueue();
  const counts = await q.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < cfg.dlqMaxSize) return;

  const allJobs = await q.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  const terminalJobs = allJobs.filter((job) => {
    if (job.finishedOn == null) return false;
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade >= maxAttempts;
  });

  terminalJobs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const purgeCount = allJobs.length - cfg.dlqMaxSize + 1;
  const toPurge = terminalJobs.slice(0, purgeCount);

  for (const job of toPurge) {
    cleanupContextDir(job.data.buildRequest.contextDir);
    try { await job.remove(); } catch { /* best-effort */ }
    logger.info('Purged oldest DLQ job', { jobId: job.id, pluginName: job.data.pluginRecord.name });
  }
}

export async function purgeDlq(): Promise<void> {
  const q = getDeadLetterQueue();
  const jobs = await q.getJobs(['waiting', 'delayed', 'completed', 'failed']);
  for (const job of jobs) {
    cleanupContextDir(job.data.buildRequest.contextDir);
  }
  await q.obliterate({ force: true });
}

/**
 * Replay a single DLQ job back onto the build queue matching the org's tier.
 * Resets retry counters so the job gets a fresh budget. Removes the DLQ
 * entry after successful enqueue so it doesn't show up twice.
 */
export async function replayDlqJob(jobId: string, quotaService: QuotaService): Promise<string | null> {
  const dlqJob = await getDeadLetterQueue().getJob(jobId);
  if (!dlqJob) return null;

  const freshData: PluginBuildJobData = {
    ...dlqJob.data,
    totalAttempts: 0,
  };
  delete (freshData as { lastError?: string }).lastError;
  delete (freshData as { failureCategory?: string }).failureCategory;

  const { orgId } = dlqJob.data;
  const tier = await getOrgTier(quotaService, orgId, getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'owner' }));
  const replayed = await getTierQueue(tier).add(`replay-${dlqJob.name}`, freshData);
  await dlqJob.remove();
  return String(replayed.id);
}

// ---------------------------------------------------------------------------
// Main worker
// ---------------------------------------------------------------------------

export function startWorker(sseManager: SSEManager, quotaService: QuotaService): void {
  if (tierWorkers.size > 0) return;

  const { concurrency } = getBuildCfg();
  const tierConcurrency: Record<QuotaTier, number> = {
    developer: parseInt(process.env.PLUGIN_BUILD_CONCURRENCY_DEVELOPER || String(concurrency), 10),
    pro: parseInt(process.env.PLUGIN_BUILD_CONCURRENCY_PRO || String(concurrency), 10),
    unlimited: parseInt(process.env.PLUGIN_BUILD_CONCURRENCY_UNLIMITED || String(concurrency), 10),
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

        if (!isApprovalStep && buildRequest.buildType !== 'metadata_only') {
          const tier = await getOrgTier(quotaService, orgId, getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'owner' }));
          const buildkitAddr = getBuildkitAddrForTier(tier);
          switch (buildRequest.buildType) {
            case 'prebuilt': {
              const tarPath = path.join(buildRequest.contextDir, 'image.tar');
              if (!fs.existsSync(tarPath)) {
                throw new Error('Prebuilt plugin is missing image.tar in ZIP archive');
              }
              const result = await loadAndPush(tarPath, buildRequest.name, buildRequest.version, buildRequest.registry, orgId);
              fullImage = result.fullImage;
              break;
            }
            case 'build_image':
            default: {
              const result = await buildAndPush(buildRequest, { buildkitAddr });
              fullImage = result.fullImage;
              break;
            }
          }
          sseManager.send(requestId, 'INFO', 'Image pushed', { fullImage });
        }

        const result = await pluginService.deployVersion(pluginRecord, userId);

        recordBuildEvent(orgId, 'completed', job, {
          pluginName: result.name,
          pluginVersion: result.version,
          pluginId: result.id,
        });

        const durationMs = job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn : undefined;
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
      decrementQuota(quotaService, orgId, 'plugins',
        getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'owner' }),
        logger.warn.bind(logger),
      );
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

    enforceDlqMaxSize()
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
      connection: getConnectionForTier(tier),
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
// DLQ worker -- re-queues retryable jobs back to the main queue
// ---------------------------------------------------------------------------

function startDlqWorker(quotaService: QuotaService): void {
  if (dlqWorker) return;

  dlqWorker = new Worker<PluginBuildJobData>(DLQ_NAME,
    async (job: Job<PluginBuildJobData>) => {
      const { orgId, pluginRecord, buildRequest, totalAttempts } = job.data;
      const budget = totalAttemptBudget();

      if ((totalAttempts ?? 0) >= budget) {
        cleanupContextDir(buildRequest.contextDir);
        decrementQuota(quotaService, orgId, 'plugins',
          getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'owner' }),
          logger.warn.bind(logger),
        );
        logger.warn('DLQ: max total attempts reached, giving up', {
          jobId: job.id,
          pluginName: pluginRecord.name,
          totalAttempts,
        });
        return;
      }

      if (!fs.existsSync(buildRequest.contextDir)) {
        throw new Error(`Context dir missing: ${buildRequest.contextDir}`);
      }

      try { fs.utimesSync(buildRequest.contextDir, new Date(), new Date()); } catch { /* ignore */ }

      logger.info('DLQ: re-queuing job', {
        jobId: job.id,
        pluginName: pluginRecord.name,
        dlqAttempt: job.attemptsMade,
        totalAttempts,
      });

      const { failureCategory: _, lastError: __, ...cleanData } = job.data;
      const tier = await getOrgTier(quotaService, orgId, getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'owner' }));
      await getTierQueue(tier).add(`retry-${pluginRecord.name}`, cleanData);
    },
    {
      connection: getConnectionForDb(0),
      concurrency: 1,
    },
  );

  dlqWorker.on('failed', (job, error) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade >= maxAttempts;

    logger.error('DLQ retry failed', {
      jobId: job.id,
      pluginName: job.data.pluginRecord.name,
      error: error.message,
      attemptsMade: job.attemptsMade,
      isFinalAttempt,
    });

    if (isFinalAttempt) {
      cleanupContextDir(job.data.buildRequest.contextDir);
      const { orgId } = job.data;
      decrementQuota(quotaService, orgId, 'plugins',
        getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'owner' }),
        logger.warn.bind(logger),
      );
      logger.warn('DLQ exhausted all retries, cleaned up', {
        jobId: job.id,
        pluginName: job.data.pluginRecord.name,
      });
    }
  });

  dlqWorker.on('completed', (job) => {
    logger.info('DLQ job processed', { jobId: job.id, name: job.name });
  });

  logger.info('DLQ worker started');
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
  if (dlqWorker) {
    await dlqWorker.close();
    dlqWorker = null;
  }
  await Promise.all(Array.from(tierWorkers.values()).map((w) => w.close()));
  tierWorkers.clear();
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
  tierCache.clear();
  logger.info('Plugin build queue shut down');
}
