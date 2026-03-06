import * as fs from 'fs';
import path from 'path';

import { createLogger, errorMessage, extractDbError, incrementQuota } from '@mwashburn160/api-core';
import type { QuotaService } from '@mwashburn160/api-core';
import type { SSEManager } from '@mwashburn160/api-server';
import { Config, CoreConstants } from '@mwashburn160/pipeline-core';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import { buildAndPush, BUILD_TEMP_ROOT } from '../helpers/docker-build';
import type { PluginBuildJobData } from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';
import type { PluginInsert } from '../services/plugin-service';

const logger = createLogger('plugin-build-queue');

const COMPLETED_JOB_RETENTION_SECS = CoreConstants.PLUGIN_BUILD_COMPLETED_RETENTION_SECS;
const FAILED_JOB_RETENTION_SECS = CoreConstants.PLUGIN_BUILD_FAILED_RETENTION_SECS;

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

/** Get (or create) the shared BullMQ queue for plugin builds. */
export function getQueue(): Queue<PluginBuildJobData> {
  if (!queue) {
    queue = new Queue<PluginBuildJobData>(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: parseInt(process.env.PLUGIN_BUILD_MAX_ATTEMPTS || '2', 10),
        backoff: { type: 'exponential', delay: parseInt(process.env.PLUGIN_BUILD_BACKOFF_DELAY_MS || '5000', 10) },
        removeOnComplete: { age: COMPLETED_JOB_RETENTION_SECS },
        removeOnFail: { age: FAILED_JOB_RETENTION_SECS },
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
export function waitForWorkerReady(timeoutMs = parseInt(process.env.PLUGIN_BUILD_WORKER_TIMEOUT_MS || '10000', 10)): Promise<void> {
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
 * Start the BullMQ worker that processes plugin Docker builds.
 * Called once from plugin service index.ts after createApp().
 */
export function startWorker(
  sseManager: SSEManager,
  quotaService: QuotaService,
): Worker<PluginBuildJobData> {
  if (worker) return worker;

  const { concurrency } = Config.get('pluginBuild');

  worker = new Worker<PluginBuildJobData>(
    QUEUE_NAME,
    async (job: Job<PluginBuildJobData>) => {
      const { requestId, orgId, userId, authToken, buildRequest, pluginRecord } = job.data;

      sseManager.send(requestId, 'INFO', 'Build started', {
        jobId: job.id,
        imageTag: pluginRecord.imageTag,
      });

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

        // 4. Send completion SSE
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
      logger.error('Plugin build failed', {
        jobId: job.id,
        requestId,
        error: error.message,
        attemptsMade: job.attemptsMade,
        ...dbDetails,
      });
      sseManager.send(requestId, 'ERROR', `Build failed: ${error.message}`, {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      });
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

/** Maximum age (ms) for orphaned temp directories before cleanup (1 hour). */
const TEMP_DIR_MAX_AGE_MS = parseInt(process.env.TEMP_DIR_MAX_AGE_MS || '3600000', 10);

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
  if (connection) {
    connection.disconnect();
    connection = null;
  }
  logger.info('Plugin build queue shut down');
}
