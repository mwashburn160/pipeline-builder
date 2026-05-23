// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';

import { createLogger, createRemoteAuditClient, decrementQuota, DEFAULT_TIER, errorMessage, extractDbError, getServiceAuthHeader, VALID_TIERS } from '@pipeline-builder/api-core';
import type { QuotaService, QuotaTier, RemoteAuditClient } from '@pipeline-builder/api-core';
import { incCounter, observe } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { Config, CoreConstants, db, schema, reportingService, runWithTenantContext, withTenantTx } from '@pipeline-builder/pipeline-core';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import { startQueueMetricsScraper, stopQueueMetricsScraper } from './queue-metrics-scraper';
import { buildAndPush, getBuildkitAddrForTier, loadAndPush, BUILD_TEMP_ROOT } from '../helpers/docker-build';
import type { FailureCategory, PluginBuildJobData } from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';

const logger = createLogger('plugin-build-queue');

const buildCfg = Config.get('pluginBuild') as {
  concurrency: number;
  maxAttempts: number;
  backoffDelayMs: number;
  workerTimeoutMs: number;
  tempDirMaxAgeMs: number;
  dlqMaxAttempts: number;
  dlqBackoffBaseMs: number;
  dlqMaxSize: number;
};

/** Max total attempts across main queue + DLQ before treating as permanent. */
const MAX_TOTAL_ATTEMPTS = buildCfg.maxAttempts + (buildCfg.dlqMaxAttempts * buildCfg.maxAttempts);

const COMPLETED_JOB_RETENTION_SECS = CoreConstants.PLUGIN_BUILD_COMPLETED_RETENTION_SECS;

// ---------------------------------------------------------------------------
// Per-org concurrency cap (multi-tenancy hardening)
// ---------------------------------------------------------------------------
//
// BullMQ OSS doesn't have built-in group-keyed concurrency; we layer a
// per-org semaphore on top of Redis. Each worker tries to INCR `pb:org-build:<id>`
// before processing â over the cap, it DECRs back and re-enqueues the job
// with a short delay so another org's job can take the worker slot. This
// gives weighted-fair-ish scheduling without partitioning the queue itself.
//
// Tuning// PLUGIN_MAX_BUILDS_PER_ORG â max in-flight builds per org (default 3)
// PLUGIN_ORG_SLOT_DELAY_MS â backoff between re-acquisition tries (default 10s)
// ORG_SLOT_TTL_SEC â defensive expiry on the counter so a crashed
// worker doesn't leak slots forever
const MAX_BUILDS_PER_ORG = parseInt(process.env.PLUGIN_MAX_BUILDS_PER_ORG || '3', 10);
const ORG_SLOT_DELAY_MS = parseInt(process.env.PLUGIN_ORG_SLOT_DELAY_MS || '10000', 10);
const ORG_SLOT_TTL_SEC = parseInt(process.env.PLUGIN_ORG_SLOT_TTL_SEC || '900', 10);
const orgSlotKey = (orgId: string) => `pb:org-build:${orgId}`;

/** Try to acquire an in-flight build slot for `orgId`. Returns true on success;
 * false if the org is already at its cap (caller should re-enqueue).
 *
 * The semaphore lives on db=0 regardless of per-tier queue partitioning —
 * one cap per org spans every tier they have access to. */
async function tryAcquireOrgSlot(orgId: string): Promise<boolean> {
  const redis = getConnectionForDb(0);
  const count = await redis.incr(orgSlotKey(orgId));
  if (count === 1) await redis.expire(orgSlotKey(orgId), ORG_SLOT_TTL_SEC);
  if (count > MAX_BUILDS_PER_ORG) {
    await redis.decr(orgSlotKey(orgId));
    return false;
  }
  return true;
}

/** Release the org's slot. Defensive: never let the counter go negative
 * (a previous worker crash could have leaked the EXPIRE TTL and let DECR
 * underflow on the next acquire). */
async function releaseOrgSlot(orgId: string): Promise<void> {
  const redis = getConnectionForDb(0);
  const count = await redis.decr(orgSlotKey(orgId));
  if (count < 0) await redis.set(orgSlotKey(orgId), '0', 'EX', ORG_SLOT_TTL_SEC);
}

// Queue name & singleton state

const QUEUE_NAME = CoreConstants.PLUGIN_BUILD_QUEUE_NAME;
const DLQ_NAME = `${QUEUE_NAME}-dlq`;

// ---------------------------------------------------------------------------
// Per-tier queue partitioning
// ---------------------------------------------------------------------------
//
// Three independent BullMQ queues â one per quota tier. Each gets its own
// Worker instance with its own concurrency budget, so a burst from Developer-
// tier traffic can't block Pro/Unlimited customers from being dispatched.
// The per-org semaphore above still enforces intra-tier fairness.
//
// Back-compat anchor: the `developer` tier keeps the original QUEUE_NAME
// (no suffix). Existing in-flight jobs in the original queue continue to be
// processed by the developer-tier worker, and any caller without a tier
// (DLQ replay path on an unknown org, tests, monitoring) maps to developer.
const TIER_QUEUE_NAMES: Record<QuotaTier, string> = {
  developer: QUEUE_NAME,
  pro: `${QUEUE_NAME}-pro`,
  unlimited: `${QUEUE_NAME}-unlimited`,
};

/**
 * Per-tier Redis DB partitioning. By default every tier shares db=0 (the
 * Redis default). Operators concerned about noisy-neighbor contention at
 * the Redis level — a flood of Developer-tier jobs slowing BLPOP latency
 * for Pro/Unlimited workers — set distinct db numbers per tier via env.
 *
 * Redis supports 0-15 by default; CLUSTER mode collapses this to db=0
 * regardless, so partitioning is only useful on single-instance / replica
 * Redis (which is the in-cluster default for this project). Operators on
 * Redis Cluster should leave the env unset and accept the shared-db model.
 *
 *   REDIS_DB_DEVELOPER=0   REDIS_DB_PRO=1   REDIS_DB_UNLIMITED=2
 *
 * The DLQ shares the developer DB (it's a back-stop for ANY failing tier
 * and is read by the operator dashboard alongside developer-tier jobs).
 */
function getRedisDbForTier(tier: QuotaTier): number {
  const envName = `REDIS_DB_${tier.toUpperCase()}`;
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return 0;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 15) return 0;
  return parsed;
}

// One ioredis client per DB number. Reusing a client for multiple Queue/
// Worker instances in the same DB is the BullMQ-recommended pattern. The
// connections are constructed lazily on first use of each tier.
const connectionsByDb = new Map<number, IORedis>();
const tierQueues = new Map<QuotaTier, Queue<PluginBuildJobData>>();
const tierWorkers = new Map<QuotaTier, Worker<PluginBuildJobData>>();
let dlq: Queue<PluginBuildJobData> | null = null;
let dlqWorker: Worker<PluginBuildJobData> | null = null;

// ---------------------------------------------------------------------------
// Per-org tier cache
// ---------------------------------------------------------------------------
//
// Tier changes are operator-initiated and rare (plan upgrade / downgrade);
// caching per-org for 5 minutes spares the quota service from a round-trip
// on every plugin build submission without making upgrades feel sluggish.
// Fail-open lookups return DEFAULT_TIER and are cached too â the next miss
// re-queries.
const TIER_CACHE_TTL_MS = parseInt(process.env.PLUGIN_TIER_CACHE_TTL_MS || '300000', 10);
const tierCache = new Map<string, { tier: QuotaTier; expiresAt: number }>();

/** Look up the org's tier with a short-TTL in-process cache. */
export async function getOrgTier( quotaService: QuotaService,
  orgId: string,
  authHeader: string,
): Promise<QuotaTier> {
  const cached = tierCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  const tier = await quotaService.getTier(orgId, authHeader);
  tierCache.set(orgId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
  return tier;
}

/**
 * Lazily-constructed remote-audit client. Pointed at the platform's
 * `/audit/events` ingest endpoint so `plugin.build.*` events land in the
 * MongoDB audit log alongside platform-emitted actions. The
 * worker continues to emit a structured Loki-bound log entry too â the
 * per-plugin drill-down dashboard reads from that path.
 */
let auditClient: RemoteAuditClient | null = null;
function getAuditClient(): RemoteAuditClient {
  if (!auditClient) auditClient = createRemoteAuditClient();
  return auditClient;
}

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

/** Get (or create) the Redis client for a specific DB number. The same
 *  client is reused for every Queue/Worker that lands in that DB — the
 *  BullMQ-recommended pattern is one ioredis client shared across all
 *  Queue/Worker constructions for a given (host, port, db). */
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

/** Get (or create) the Redis client used by BullMQ for a given tier's queue
 *  and worker. Falls through to db=0 when REDIS_DB_<TIER> is unset. */
function getConnectionForTier(tier: QuotaTier): IORedis {
  return getConnectionForDb(getRedisDbForTier(tier));
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

/** Get (or create) the dead letter queue for failed plugin builds. The
 *  DLQ lives on db=0 — it's a back-stop for ANY tier's failures and the
 *  operator dashboard reads from a single, well-known location. */
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

/** Get (or create) the BullMQ queue for a given tier. The queue's Redis
 *  client is selected by `REDIS_DB_<TIER>` — operators who want per-tier
 *  Redis DB partitioning set distinct numbers per tier; otherwise every
 *  tier lands on db=0. */
export function getTierQueue(tier: QuotaTier): Queue<PluginBuildJobData> {
  let q = tierQueues.get(tier);
  if (!q) {
    q = new Queue<PluginBuildJobData>(TIER_QUEUE_NAMES[tier], {
      connection: getConnectionForTier(tier),
      defaultJobOptions: {
        attempts: buildCfg.maxAttempts,
        backoff: { type: 'exponential', delay: buildCfg.backoffDelayMs },
        removeOnComplete: { age: COMPLETED_JOB_RETENTION_SECS },
        removeOnFail: { age: CoreConstants.PLUGIN_BUILD_FAILED_RETENTION_SECS },
      },
    });
    tierQueues.set(tier, q);
  }
  return q;
}

/** All per-tier queues. Used by metrics scraper + queue-status aggregation. */
export function getAllTierQueues(): Array<{ tier: QuotaTier; queue: Queue<PluginBuildJobData> }> {
  return VALID_TIERS.map((tier) => ({ tier, queue: getTierQueue(tier) }));
}

/** Submit a build to the queue matching the org's tier. */
export async function enqueueBuild( tier: QuotaTier,
  jobName: string,
  jobData: PluginBuildJobData,
): Promise<void> {
  await getTierQueue(tier).add(jobName, jobData);
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Classify a build error as retryable or permanent. */
function classifyFailure(error: Error): FailureCategory {
  const msg = error.message;
  const dbCode = extractDbError(error)?.dbCode;

  // Permanent: DB schema errors, constraint violations, compliance, validation
  if (dbCode === '42703' || dbCode === '42P01' || dbCode === '23505') return 'permanent';
  if (msg.includes('COMPLIANCE_VIOLATION') || msg.includes('VALIDATION_ERROR')) return 'permanent';
  if (msg.includes('missing image.tar') || msg.includes('Tarball not found')) return 'permanent';

  return 'retryable';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the developer-tier worker is connected and ready to process
 * jobs. We check the connection for the developer-tier DB specifically —
 * other tiers may run on separate DBs (REDIS_DB_<TIER>) and have their own
 * client whose state we don't conflate with "queue infrastructure is up". */
function isWorkerReady(): boolean {
  if (!tierWorkers.get(DEFAULT_TIER)) return false;
  const conn = connectionsByDb.get(getRedisDbForTier(DEFAULT_TIER));
  return conn?.status === 'ready';
}

/**
 * Wait for the BullMQ worker infrastructure to connect to Redis.
 * Resolves when ready, rejects after timeout.
 */
export function waitForWorkerReady(timeoutMs = buildCfg.workerTimeoutMs): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isWorkerReady()) {
      resolve();
      return;
    }

    const worker = tierWorkers.get(DEFAULT_TIER);
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      worker?.off('ready', onReady);
      reject(new Error(`Worker not ready after ${timeoutMs}ms`));
    }, timeoutMs);

    worker?.on('ready', onReady);
  });
}

/** Remove the temporary build context directory. */
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
 * Persist a plugin build event to the pipeline_events table (fire-and-forget),
 * then invalidate the org's reporting cache so the dashboard reflects it on
 * next read.
 *
 * Plugin builds aren't tied to a pipelineArn (no registry mapping), so we
 * write directly to `pipeline_event` rather than going through the reporting
 * service's `/reports/events` ingest endpoint (which requires an ARN). The
 * cache invalidation runs through the same `reportingService.invalidateOrg`
 * used by the ingest path â without it, the dashboard serves stale data
 * after every plugin build until the org's TTL elapses.
 */
function recordBuildEvent( orgId: string,
  status: 'completed' | 'failed',
  job: Job,
  detail: Record<string, unknown>,
): void {
  const startedMs = job.processedOn ?? job.timestamp;
  const completedMs = job.finishedOn ?? Date.now();
  const durationMs = startedMs ? completedMs - startedMs: undefined;

  if (!db?.insert) return;

  // pipeline_events has an RLS policy keyed on `app.org_id`; once enforcement
  // is on (FORCE ROW LEVEL SECURITY), the insert needs the GUC set to the
  // build's orgId. `withTenantTx` opens a tx + SET LOCALs the GUCs for the
  // duration. Outside FORCE, this is a no-op overhead-wise (~one extra
  // round-trip per build, well within the existing build latency budget).
  withTenantTx((tx) => tx.insert(schema.pipelineEvent)
    .values({
      orgId,
      eventSource: 'plugin-build',
      eventType: 'BUILD',
      status,
      executionId: job.id ?? undefined,
      errorMessage: status === 'failed' ? (detail.errorMessage as string): undefined,
      startedAt: startedMs ? new Date(startedMs): undefined,
      completedAt: new Date(completedMs),
      durationMs,
      detail: {
        ...detail,
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      },
    }))
    .catch((err: unknown) => {
      // The DB insert itself failed â the event was NOT recorded.
      logger.warn('Failed to record build event', { error: errorMessage(err) });
    })
    .then(() => reportingService.invalidateOrg(orgId))
    .catch((err: unknown) => {
      // The event was recorded but cache invalidation failed; dashboards
      // will serve stale data until next TTL.
      logger.warn('Reporting cache invalidation failed after build event', { orgId, error: errorMessage(err) });
    });
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
 * Enforce DLQ max size by purging oldest terminal jobs first.
 * Only purges completed/failed jobs; active/waiting/delayed jobs are skipped.
 */
async function enforceDlqMaxSize(): Promise<void> {
  const q = getDeadLetterQueue();
  const allJobs = await q.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  if (allJobs.length < buildCfg.dlqMaxSize) return;

  // Only purge terminal jobs (completed, or failed with no retries left)
  const terminalJobs = allJobs.filter((job) => {
    if (job.finishedOn == null) return false;
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade >= maxAttempts;
  });

  terminalJobs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const purgeCount = allJobs.length - buildCfg.dlqMaxSize + 1;
  const toPurge = terminalJobs.slice(0, purgeCount);

  for (const job of toPurge) {
    cleanupContextDir(job.data.buildRequest.contextDir);
    try { await job.remove(); } catch { /* best-effort */ }
    logger.info('Purged oldest DLQ job', { jobId: job.id, pluginName: job.data.pluginRecord.name });
  }
}

/**
 * Clean up context dirs for all non-active DLQ jobs, then obliterate the queue.
 * Skips dirs for jobs currently being processed to avoid mid-operation deletion.
 */
export async function purgeDlq(): Promise<void> {
  const q = getDeadLetterQueue();
  const jobs = await q.getJobs(['waiting', 'delayed', 'completed', 'failed']);
  for (const job of jobs) {
    cleanupContextDir(job.data.buildRequest.contextDir);
  }
  await q.obliterate({ force: true });
}

/**
 * Replay a single DLQ job back onto the build queue matching the org's tier
 *. Resets retry counters so the job gets a fresh budget. Removes the
 * DLQ entry after successful enqueue so it doesn't show up twice.
 *
 * @returns the new job's id, or null if the source DLQ job was not found.
 * @throws if the requesting org doesn't own the job (caller is responsible
 * for that check; this helper does no auth).
 */
export async function replayDlqJob( jobId: string,
  quotaService: QuotaService,
): Promise<string | null> {
  const dlqJob = await getDeadLetterQueue().getJob(jobId);
  if (!dlqJob) return null;

  // Reset transient failure metadata so the replay starts clean.
  const freshData: PluginBuildJobData = {
    ...dlqJob.data,
    totalAttempts: 0,
  };
  delete (freshData as { lastError?: string }).lastError;
  delete (freshData as { failureCategory?: string }).failureCategory;

  const { orgId } = dlqJob.data;
  const tier = await getOrgTier( quotaService, orgId,
    getServiceAuthHeader({ serviceName: 'plugin', orgId }),
  );
  const replayed = await getTierQueue(tier).add(`replay-${dlqJob.name}`, freshData);
  await dlqJob.remove();
  return String(replayed.id);
}

// ---------------------------------------------------------------------------
// Main worker
// ---------------------------------------------------------------------------

/**
 * Start one BullMQ worker per quota tier. Each tier runs against
 * its own queue with its own concurrency budget, so Developer-tier traffic
 * can't block Pro/Unlimited dispatch.
 *
 * Idempotent — repeat calls are a no-op when workers are already running.
 *
 * Tunables: PLUGIN_BUILD_CONCURRENCY_<DEVELOPER|PRO|UNLIMITED>
 * Per-tier worker concurrency. Each defaults to PLUGIN_BUILD_CONCURRENCY,
 * giving 3× the in-flight budget across the tiers — intentional, since the
 * whole point of per-tier partitioning is more cross-tier parallelism.
 *
 * Called once from plugin service index.ts after createApp().
 */
export function startWorker(sseManager: SSEManager, quotaService: QuotaService): void {
  if (tierWorkers.size > 0) return;

  const { concurrency } = buildCfg;
  const tierConcurrency: Record<QuotaTier, number> = {
    developer: parseInt(process.env.PLUGIN_BUILD_CONCURRENCY_DEVELOPER || String(concurrency), 10),
    pro: parseInt(process.env.PLUGIN_BUILD_CONCURRENCY_PRO || String(concurrency), 10),
    unlimited: parseInt(process.env.PLUGIN_BUILD_CONCURRENCY_UNLIMITED || String(concurrency), 10),
  };

  const processor = async (job: Job<PluginBuildJobData>, token?: string) => {
    const { requestId, orgId, userId, buildRequest, pluginRecord } = job.data;

    // Establish the per-job tenant context so any `withTenantTx` call
    // through CrudService (e.g. pluginService.deployVersion below) SET
    // LOCALs `app.org_id` to this build's org. Without this, the worker
    // runs outside any AsyncLocalStorage scope and the GUCs default to
    // empty â fine in owner-bypass mode but a hard failure once tables
    // are FORCE'd. `isSuperAdmin: false` because a build is always
    // acting on behalf of the org that submitted it.
    return runWithTenantContext({ orgId, isSuperAdmin: false }, async () => {

      // Per-org concurrency gate. Acquire BEFORE any other work so a noisy
      // org's burst can't starve the histogram + SSE notifications below.
      // On miss → move the job to delayed and exit (Worker.RateLimitError
      // is BullMQ's signal that the job has been taken out of the worker
      // lifecycle; `finally` blocks below shouldn't run for this branch).
      if (!await tryAcquireOrgSlot(orgId)) {
        await job.moveToDelayed(Date.now() + ORG_SLOT_DELAY_MS, token);
        throw Worker.RateLimitError();
      }
      // From this point onward the slot is held; release in `finally` so
      // every exit path (success / failure / unexpected throw) frees it.
      try {

        // Histogram for the Queue Health dashboard. `timestamp` is when the
        // job was enqueued; we observe the wait time (queue depth × concurrency
        // dynamics) at the moment the worker pulls it. processedOn is set by
        // BullMQ around the same instant â use `now()` to be safe across
        // BullMQ versions.
        if (job.timestamp) {
          observe('plugin_job_wait_seconds', {}, (Date.now() - job.timestamp) / 1000);
        }

        sseManager.send(requestId, 'INFO', 'Build started', {
          jobId: job.id,
          plugin: `${pluginRecord.name}:${pluginRecord.version}`,
        });

        // Touch the build context directory to prevent cleanup during long queue waits
        try { fs.utimesSync(buildRequest.contextDir, new Date(), new Date()); } catch { /* ignore */ }

        try {
          const isApprovalStep = pluginRecord.pluginType === 'ManualApprovalStep';
          let fullImage = '';

          if (!isApprovalStep && buildRequest.buildType !== 'metadata_only') {
          // resolve the org's tier (cached) and pick the per-tier
          // buildkitd address. Defaults to the in-pod sidecar when no
          // per-tier env override is set so single-buildkitd deploys are
          // unaffected.
            const tier = await getOrgTier( quotaService, orgId,
              getServiceAuthHeader({ serviceName: 'plugin', orgId }),
            );
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

          // quota slot was reserved at upload time, not here. Success
          // keeps the reservation; the worker's `failed` handler decrements
          // on permanent failure to give the slot back.

          recordBuildEvent(orgId, 'completed', job, {
            pluginName: result.name,
            pluginVersion: result.version,
            pluginId: result.id,
          });

          // Canonical audit shape â `action` is one of the AuditAction enum
          // members defined in platform/src/models/audit-event.ts so the
          // vocabulary is unified across the codebase. `eventCategory`
          // / `event` / `pluginName` stay populated for promtail (see
          // deploy/*/config/promtail/*.yml) â the per-plugin drill-down
          // dashboard still queries against those Loki labels.
          const durationMs = job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn: undefined;
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

          // Push to MongoDB audit_events via the platform's /audit/events
          // ingest endpoint so the audit log is the single source of truth.
          // Fire-and-forget; the client never throws back.
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
        } catch (err) {
        // Don't clean dir here â the 'failed' handler decides based on classification
          throw err;
        }
      } finally {
        // Outer try/finally that brackets the slot acquire/release. Every
        // exit path through the build handler â success, BullMQ-caught
        // throw, or our own moveToDelayed signal â flows through here so the
        // org slot doesn't leak. (The moveToDelayed branch returns earlier
        // before this finally and releases nothing because it didn't
        // acquire â see the `tryAcquireOrgSlot` guard at top.)
        await releaseOrgSlot(orgId);
      }
    }); // end runWithTenantContext
  };

  // -- Error handling -------------------------------------------------------

  const failedHandler = (job: Job<PluginBuildJobData> | undefined, error: Error) => {
    if (!job) return;

    const { requestId, orgId, pluginRecord, buildRequest } = job.data;
    const totalAttempts = (job.data.totalAttempts ?? 0) + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade >= maxAttempts;

    // Prometheus counter. Status is `timeout` when error message matches the
    // BullMQ timeout signal â same shape the docker-build helper uses for the
    // SIGKILL-on-deadline path. Everything else is `failed`.
    const isTimeout = /timed out|timeout/i.test(error.message);
    incCounter('plugin_builds_total', {
      status: isTimeout ? 'timeout': 'failed',
      org_id: orgId ?? 'unknown',
      // Per-plugin label is on the COUNTER only (low write rate, low cardinality
      // risk). The duration histogram below intentionally omits plugin_name â
      // each bucket × label combination explodes for histograms. Drill-down
      // for durations is served via Loki in PR-D2.
      plugin_name: pluginRecord.name,
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

    // Per-plugin drill-down event (see analogous emit on completion).
    // `action` matches the AuditAction enum in platform/src/models/audit-event.ts
    // for vocabulary parity.
    const action = isTimeout ? 'plugin.build.timeout': 'plugin.build.failed';
    logger.info('Plugin build event', {
      eventCategory: 'plugin-build',
      action,
      event: isTimeout ? 'timeout': 'failed',
      actorId: job.data.userId,
      orgId,
      targetType: 'plugin',
      pluginName: pluginRecord.name,
      pluginVersion: pluginRecord.version,
      jobId: job.id,
      errorMessage: error.message,
    });

    // Only emit to MongoDB on the FINAL attempt â interim retries shouldn't
    // pollute the audit log. The completion path emits unconditionally
    // because it only runs once. `isFinalAttempt` is checked below for the
    // dir-cleanup gate; we mirror that here so the audit log records the
    // terminal outcome only.
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

    if (!isFinalAttempt) return; // Main queue will retry â keep dir

    const category = classifyFailure(error);

    // Circuit breaker: if total attempts across all cycles exceeded, treat as permanent
    if (category === 'permanent' || totalAttempts >= MAX_TOTAL_ATTEMPTS) {
      cleanupContextDir(buildRequest.contextDir);
      // the upload route reserved a `plugins` slot for this build;
      // permanent failure here means the org never got the plugin, so give
      // the slot back. Fire-and-forget â logged-only on rollback failure.
      decrementQuota( quotaService, orgId, 'plugins',
        getServiceAuthHeader({ serviceName: 'plugin', orgId }),
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

    // Retryable: move to DLQ for retry (keep dir alive)
    const dlqData: PluginBuildJobData = {
      ...job.data,
      failureCategory: category,
      lastError: error.message,
      totalAttempts,
    };

    enforceDlqMaxSize()
      .then(() => getDeadLetterQueue().add(`dlq-${job.id}`, dlqData, {
        jobId: `dlq-${job.id}`,
        attempts: buildCfg.dlqMaxAttempts,
        backoff: { type: 'exponential', delay: buildCfg.dlqBackoffBaseMs },
      }))
      .then(() => {
        logger.info('Moved to DLQ for retry', {
          jobId: job.id,
          pluginName: pluginRecord.name,
          totalAttempts,
          dlqAttempts: buildCfg.dlqMaxAttempts,
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
    const pluginName = job.data?.pluginRecord?.name ?? 'unknown';
    incCounter('plugin_builds_total', { status: 'success', org_id: orgId, plugin_name: pluginName });
    // Histogram covers wait-to-start as well as run time: `processedOn` is
    // when the worker picked up the job, `finishedOn` is when the handler
    // resolved. `finishedOn` should always be set on completion but BullMQ's
    // types mark it optional, hence the guard.
    if (job.processedOn && job.finishedOn) {
      observe( 'plugin_build_duration_seconds',
        { org_id: orgId },
        (job.finishedOn - job.processedOn) / 1000,
      );
    }
    logger.info('Plugin build completed', { jobId: job.id, name: job.name });
  };

  // Spin up one Worker per tier. They share the same processor + handlers
  // but read from independent queues so cross-tier scheduling is isolated.
  for (const tier of VALID_TIERS) {
    const tierQueue = getTierQueue(tier); // ensure queue exists before worker attaches
    const tierWorker = new Worker<PluginBuildJobData>( tierQueue.name,
      processor,
      {
        // Worker connection matches the queue's — both must speak to the
        // same Redis DB or the worker won't see the jobs.
        connection: getConnectionForTier(tier),
        concurrency: tierConcurrency[tier],
      },
    );

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
  startQueueMetricsScraper([
    ...getAllTierQueues().map(({ queue }) => ({ name: queue.name, queue })),
    { name: DLQ_NAME, queue: getDeadLetterQueue() },
  ]);
}

// ---------------------------------------------------------------------------
// DLQ worker â re-queues retryable jobs back to main queue
// ---------------------------------------------------------------------------

function startDlqWorker(quotaService: QuotaService): void {
  if (dlqWorker) return;

  dlqWorker = new Worker<PluginBuildJobData>( DLQ_NAME,
    async (job: Job<PluginBuildJobData>) => {
      const { orgId, pluginRecord, buildRequest, totalAttempts } = job.data;

      // Circuit breaker: stop retrying if total attempts exceeded
      if ((totalAttempts ?? 0) >= MAX_TOTAL_ATTEMPTS) {
        cleanupContextDir(buildRequest.contextDir);
        // terminal failure path â give the reserved quota slot back.
        decrementQuota( quotaService, orgId, 'plugins',
          getServiceAuthHeader({ serviceName: 'plugin', orgId }),
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

      // Touch dir to prevent cleanup during backoff
      try { fs.utimesSync(buildRequest.contextDir, new Date(), new Date()); } catch { /* ignore */ }

      logger.info('DLQ: re-queuing job', {
        jobId: job.id,
        pluginName: pluginRecord.name,
        dlqAttempt: job.attemptsMade,
        totalAttempts,
      });

      // Carry totalAttempts forward, strip DLQ-specific metadata
      const { failureCategory: _, lastError: __, ...cleanData } = job.data;
      // Route retries back to the org's tier queue. Tier lookup
      // uses the in-process cache and fail-opens to developer â a misroute
      // here is harmless beyond the cross-tier scheduling property.
      const tier = await getOrgTier( quotaService, orgId,
        getServiceAuthHeader({ serviceName: 'plugin', orgId }),
      );
      await getTierQueue(tier).add(`retry-${pluginRecord.name}`, cleanData);
    },
    {
      // DLQ worker shares db=0 with the DLQ queue itself — see comment on
      // getDeadLetterQueue() for why the DLQ lives on the default DB.
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
      // terminal failure path â give the reserved quota slot back.
      const { orgId } = job.data;
      decrementQuota( quotaService, orgId, 'plugins',
        getServiceAuthHeader({ serviceName: 'plugin', orgId }),
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
// Periodic temp directory cleanup
// ---------------------------------------------------------------------------

const TEMP_DIR_MAX_AGE_MS = buildCfg.tempDirMaxAgeMs;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Remove temp directories older than TEMP_DIR_MAX_AGE_MS, skipping dirs with active jobs. */
function cleanupStaleTempDirs(): void {
  const tmpRoot = BUILD_TEMP_ROOT;
  if (!fs.existsSync(tmpRoot)) return;

  getProtectedContextDirs().then((protectedDirs) => {
    try {
      const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(tmpRoot, entry.name);
        if (protectedDirs.has(dirPath)) continue;
        try {
          const stat = fs.statSync(dirPath);
          if (now - stat.mtimeMs > TEMP_DIR_MAX_AGE_MS) {
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

/** Start periodic cleanup of orphaned temp directories. */
function startTempCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupStaleTempDirs, TEMP_DIR_MAX_AGE_MS);
  cleanupTimer.unref();
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/** Close all per-tier workers + queues, the DLQ, Redis, and the cleanup
 * timer. Drains the tier cache too so a hot-restart in the same process
 * (tests) starts clean. */
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
  // Disconnect every per-DB Redis client. With per-tier partitioning this
  // can be up to 3 clients (one per distinct REDIS_DB_<TIER>); without
  // partitioning it's just db=0. Iteration is safe — `disconnect()` is
  // synchronous and the map is cleared right after.
  for (const conn of connectionsByDb.values()) {
    conn.disconnect();
  }
  connectionsByDb.clear();
  tierCache.clear();
  logger.info('Plugin build queue shut down');
}
