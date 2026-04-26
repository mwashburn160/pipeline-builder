// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';

import { createLogger, errorMessage, extractDbError, incrementQuota } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import type { SSEManager } from '@pipeline-builder/api-server';
import { Config, CoreConstants, db, schema } from '@pipeline-builder/pipeline-core';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import { buildAndPush, loadAndPush, BUILD_TEMP_ROOT } from '../helpers/docker-build';
import type { FailureCategory, PluginBuildJobData } from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';
import type { PluginInsert } from '../services/plugin-service';

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

// Queue name & singleton state

const QUEUE_NAME = CoreConstants.PLUGIN_BUILD_QUEUE_NAME;
const DLQ_NAME = `${QUEUE_NAME}-dlq`;

let connection: IORedis | null = null;
let queue: Queue<PluginBuildJobData> | null = null;
let dlq: Queue<PluginBuildJobData> | null = null;
let worker: Worker<PluginBuildJobData> | null = null;
let dlqWorker: Worker<PluginBuildJobData> | null = null;

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

function getConnection(): IORedis {
  if (!connection) {
    const redis = Config.get('redis');
    const host = redis.host;
    const port = redis.port;

    connection = new IORedis({
      host,
      port,
      maxRetriesPerRequest: null, // Required by BullMQ
    });

    connection.on('connect', () => {
      logger.info('Redis connected', { host, port });
    });
    connection.on('error', (err) => {
      logger.error('Redis connection error', { error: err.message, host, port });
    });
    connection.on('close', () => {
      logger.warn('Redis connection closed', { host, port });
    });
    connection.on('reconnecting', () => {
      logger.info('Redis reconnecting', { host, port });
    });
  }
  return connection;
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

/** Get (or create) the dead letter queue for failed plugin builds. */
export function getDeadLetterQueue(): Queue<PluginBuildJobData> {
  if (!dlq) {
    dlq = new Queue<PluginBuildJobData>(DLQ_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
  }
  return dlq;
}

/** Get (or create) the shared BullMQ queue for plugin builds. */
export function getQueue(): Queue<PluginBuildJobData> {
  if (!queue) {
    queue = new Queue<PluginBuildJobData>(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: buildCfg.maxAttempts,
        backoff: { type: 'exponential', delay: buildCfg.backoffDelayMs },
        removeOnComplete: { age: COMPLETED_JOB_RETENTION_SECS },
        removeOnFail: { age: CoreConstants.PLUGIN_BUILD_FAILED_RETENTION_SECS },
      },
    });
  }
  return queue;
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
  if (msg.includes('missing image.tar') || msg.includes('not supported with kaniko') || msg.includes('Could not parse loaded image')) return 'permanent';

  return 'retryable';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the worker is connected and ready to process jobs. */
export function isWorkerReady(): boolean {
  if (!worker || !connection) return false;
  return connection.status === 'ready';
}

/**
 * Wait for the BullMQ worker to connect to Redis.
 * Resolves when ready, rejects after timeout.
 */
export function waitForWorkerReady(timeoutMs = buildCfg.workerTimeoutMs): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isWorkerReady()) {
      resolve();
      return;
    }

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
 * Persist a plugin build event to the pipeline_events table (fire-and-forget).
 */
function recordBuildEvent(
  orgId: string,
  status: 'completed' | 'failed',
  job: Job,
  detail: Record<string, unknown>,
): void {
  const startedMs = job.processedOn ?? job.timestamp;
  const completedMs = job.finishedOn ?? Date.now();
  const durationMs = startedMs ? completedMs - startedMs : undefined;

  if (!db?.insert) return;

  db.insert(schema.pipelineEvent)
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
    .catch((err: unknown) => {
      logger.warn('Failed to record build event', { error: errorMessage(err) });
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
    const [mainJobs, dlqJobs] = await Promise.all([
      getQueue().getJobs([...states]),
      getDeadLetterQueue().getJobs([...states]),
    ]);
    for (const job of [...mainJobs, ...dlqJobs]) {
      const dir = job.data?.buildRequest?.contextDir;
      if (dir) dirs.add(dir);
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
 * Replay a single DLQ job back onto the main build queue.
 * Resets retry counters so the job gets a fresh budget. Removes the DLQ entry
 * after successful enqueue so it doesn't show up twice.
 *
 * @returns the new job's id, or null if the source DLQ job was not found.
 * @throws if the requesting org doesn't own the job (caller is responsible
 *         for that check; this helper does no auth).
 */
export async function replayDlqJob(jobId: string): Promise<string | null> {
  const dlq = getDeadLetterQueue();
  const dlqJob = await dlq.getJob(jobId);
  if (!dlqJob) return null;

  // Reset transient failure metadata so the replay starts clean.
  const freshData: PluginBuildJobData = {
    ...dlqJob.data,
    totalAttempts: 0,
  };
  delete (freshData as { lastError?: string }).lastError;
  delete (freshData as { failureCategory?: string }).failureCategory;

  const main = getQueue();
  const replayed = await main.add(`replay-${dlqJob.name}`, freshData);
  await dlqJob.remove();
  return String(replayed.id);
}

// ---------------------------------------------------------------------------
// Main worker
// ---------------------------------------------------------------------------

/**
 * Start the BullMQ worker that processes plugin Docker builds.
 * Called once from plugin service index.ts after createApp().
 */
export function startWorker(
  sseManager: SSEManager,
  quotaService: QuotaService,
): Worker<PluginBuildJobData> {
  if (worker) return worker;

  const { concurrency } = buildCfg;

  worker = new Worker<PluginBuildJobData>(
    QUEUE_NAME,
    async (job: Job<PluginBuildJobData>) => {
      const { requestId, orgId, userId, authToken, buildRequest, pluginRecord } = job.data;

      sseManager.send(requestId, 'INFO', 'Build started', {
        jobId: job.id,
        imageTag: pluginRecord.imageTag,
      });

      // Touch the build context directory to prevent cleanup during long queue waits
      try { fs.utimesSync(buildRequest.contextDir, new Date(), new Date()); } catch { /* ignore */ }

      try {
        const isApprovalStep = pluginRecord.pluginType === 'ManualApprovalStep';
        let fullImage = '';

        if (!isApprovalStep && buildRequest.buildType !== 'metadata_only') {
          switch (buildRequest.buildType) {
            case 'prebuilt': {
              const tarPath = path.join(buildRequest.contextDir, 'image.tar');
              if (!fs.existsSync(tarPath)) {
                throw new Error('Prebuilt plugin is missing image.tar in ZIP archive');
              }
              const result = await loadAndPush(tarPath, buildRequest.imageTag, buildRequest.registry);
              fullImage = result.fullImage;
              break;
            }
            case 'build_image':
            default: {
              const result = await buildAndPush(buildRequest);
              fullImage = result.fullImage;
              break;
            }
          }
          sseManager.send(requestId, 'INFO', 'Image pushed', { fullImage });
        }

        const result = await pluginService.deployVersion(pluginRecord as unknown as PluginInsert, userId);

        incrementQuota(quotaService, orgId, 'plugins', authToken, logger.warn.bind(logger));

        recordBuildEvent(orgId, 'completed', job, {
          pluginName: result.name,
          pluginVersion: result.version,
          imageTag: result.imageTag,
          pluginId: result.id,
        });

        sseManager.send(requestId, 'COMPLETED', 'Plugin deployed', {
          id: result.id,
          name: result.name,
          version: result.version,
          imageTag: result.imageTag,
          fullImage,
        });

        cleanupContextDir(buildRequest.contextDir);

        return { pluginId: result.id, fullImage };
      } catch (err) {
        // Don't clean dir here — the 'failed' handler decides based on classification
        throw err;
      }
    },
    {
      connection: getConnection(),
      concurrency,
    },
  );

  // -- Error handling -------------------------------------------------------

  worker.on('failed', (job, error) => {
    if (!job) return;

    const { requestId, orgId, pluginRecord, buildRequest } = job.data;
    const totalAttempts = (job.data.totalAttempts ?? 0) + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade >= maxAttempts;

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
      imageTag: pluginRecord.imageTag,
      errorMessage: error.message,
    });

    if (!isFinalAttempt) return; // Main queue will retry — keep dir

    const category = classifyFailure(error);

    // Circuit breaker: if total attempts across all cycles exceeded, treat as permanent
    if (category === 'permanent' || totalAttempts >= MAX_TOTAL_ATTEMPTS) {
      cleanupContextDir(buildRequest.contextDir);
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
  });

  worker.on('error', (error) => {
    logger.error('Worker error', { error: error.message });
  });

  worker.on('ready', () => {
    logger.info('Plugin build worker ready (Redis connected)');
  });

  worker.on('completed', (job) => {
    logger.info('Plugin build completed', { jobId: job.id, name: job.name });
  });

  logger.info('Plugin build worker started', { concurrency });

  startDlqWorker();
  startTempCleanup();

  return worker;
}

// ---------------------------------------------------------------------------
// DLQ worker — re-queues retryable jobs back to main queue
// ---------------------------------------------------------------------------

function startDlqWorker(): void {
  if (dlqWorker) return;

  dlqWorker = new Worker<PluginBuildJobData>(
    DLQ_NAME,
    async (job: Job<PluginBuildJobData>) => {
      const { pluginRecord, buildRequest, totalAttempts } = job.data;

      // Circuit breaker: stop retrying if total attempts exceeded
      if ((totalAttempts ?? 0) >= MAX_TOTAL_ATTEMPTS) {
        cleanupContextDir(buildRequest.contextDir);
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
      await getQueue().add(`retry-${pluginRecord.name}`, cleanData);
    },
    {
      connection: getConnection(),
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

/** Close worker, queue, Redis connections, and cleanup timer. */
export async function shutdownQueue(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (dlqWorker) {
    await dlqWorker.close();
    dlqWorker = null;
  }
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (dlq) {
    await dlq.close();
    dlq = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
  logger.info('Plugin build queue shut down');
}
