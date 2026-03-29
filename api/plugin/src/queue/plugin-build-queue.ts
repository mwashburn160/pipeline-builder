import * as fs from 'fs';
import path from 'path';

import { createLogger, errorMessage, extractDbError, incrementQuota } from '@mwashburn160/api-core';
import type { QuotaService } from '@mwashburn160/api-core';
import type { SSEManager } from '@mwashburn160/api-server';
import { Config, CoreConstants, db, schema } from '@mwashburn160/pipeline-core';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import { buildAndPush, BUILD_TEMP_ROOT } from '../helpers/docker-build';
import type { PluginBuildJobData } from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';
import type { PluginInsert } from '../services/plugin-service';

const logger = createLogger('plugin-build-queue');

const buildCfg = Config.get('pluginBuild') as {
  concurrency: number;
  maxAttempts: number;
  backoffDelayMs: number;
  workerTimeoutMs: number;
  tempDirMaxAgeMs: number;
};

const COMPLETED_JOB_RETENTION_SECS = CoreConstants.PLUGIN_BUILD_COMPLETED_RETENTION_SECS;

// Queue name & singleton state

const QUEUE_NAME = CoreConstants.PLUGIN_BUILD_QUEUE_NAME;

let connection: IORedis | null = null;
let queue: Queue<PluginBuildJobData> | null = null;
let worker: Worker<PluginBuildJobData> | null = null;

// Redis connection

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

// Queue

/** Dead letter queue name for failed plugin builds */
const DLQ_NAME = `${QUEUE_NAME}-dlq`;

let dlq: Queue<PluginBuildJobData> | null = null;

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

// Worker

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
 * Used for build reporting — never blocks the build pipeline.
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

  if (!db?.insert) return; // db may be unavailable in unit tests

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
        // 1. Build and push Docker image (skipped for ManualApprovalStep — no Docker image needed)
        const isApprovalStep = pluginRecord.pluginType === 'ManualApprovalStep';
        let fullImage = '';

        if (!isApprovalStep) {
          const buildResult = await buildAndPush(buildRequest);
          fullImage = buildResult.fullImage;
          sseManager.send(requestId, 'INFO', 'Image pushed', { fullImage });
        }

        // 2. Persist to database (name-scoped default + upsert)
        const result = await pluginService.deployVersion(pluginRecord as unknown as PluginInsert, userId);

        // 3. Increment quota
        incrementQuota(quotaService, orgId, 'plugins', authToken, logger.warn.bind(logger));

        // 4. Persist build event for reporting
        recordBuildEvent(orgId, 'completed', job, {
          pluginName: result.name,
          pluginVersion: result.version,
          imageTag: result.imageTag,
          pluginId: result.id,
        });

        // 5. Send completion SSE
        sseManager.send(requestId, 'COMPLETED', 'Plugin deployed', {
          id: result.id,
          name: result.name,
          version: result.version,
          imageTag: result.imageTag,
          fullImage,
        });

        // Clean up on success
        cleanupContextDir(buildRequest.contextDir);

        return { pluginId: result.id, fullImage };
      } catch (err) {
        // Only clean up build context after final attempt (so retries can reuse it)
        const maxAttempts = job.opts.attempts ?? 1;
        if (job.attemptsMade >= maxAttempts) {
          cleanupContextDir(buildRequest.contextDir);
        }
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
    if (job) {
      const { requestId } = job.data;
      const dbDetails = extractDbError(error);
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade >= maxAttempts;

      logger.error('Plugin build failed', {
        jobId: job.id,
        requestId,
        error: error.message,
        attemptsMade: job.attemptsMade,
        isFinalAttempt,
        ...dbDetails,
      });
      sseManager.send(requestId, 'ERROR', 'Build failed: an error occurred during the build process', {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        maxAttempts,
      });

      // Persist build failure event for reporting
      const { orgId, pluginRecord } = job.data;
      recordBuildEvent(orgId, 'failed', job, {
        pluginName: pluginRecord.name,
        pluginVersion: pluginRecord.version,
        imageTag: pluginRecord.imageTag,
        errorMessage: error.message,
      });

      // Move to dead letter queue after final attempt for debugging
      if (isFinalAttempt) {
        getDeadLetterQueue().add(`dlq-${job.id}`, job.data, {
          jobId: `dlq-${job.id}`,
        }).catch((dlqErr) => {
          logger.warn('Failed to move job to DLQ', { jobId: job.id, error: errorMessage(dlqErr) });
        });
      }
    }
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

  // Start periodic cleanup of orphaned temp directories
  startTempCleanup();

  return worker;
}

// Periodic temp directory cleanup

/** Maximum age (ms) for orphaned temp directories before cleanup. */
const TEMP_DIR_MAX_AGE_MS = buildCfg.tempDirMaxAgeMs;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Remove temp directories older than TEMP_DIR_MAX_AGE_MS. */
function cleanupStaleTempDirs(): void {
  const tmpRoot = BUILD_TEMP_ROOT;
  if (!fs.existsSync(tmpRoot)) return;

  try {
    const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(tmpRoot, entry.name);
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
}

/** Start periodic cleanup of orphaned temp directories. */
function startTempCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupStaleTempDirs, TEMP_DIR_MAX_AGE_MS);
  cleanupTimer.unref(); // Don't prevent process exit
}

// Graceful shutdown

/** Close worker, queue, Redis connections, and cleanup timer. */
export async function shutdownQueue(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
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
