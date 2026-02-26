/**
 * @module queue/plugin-build-queue
 * @description BullMQ queue for async Docker plugin builds.
 *
 * Architecture: Queue + Worker run in the same plugin service process.
 * The worker calls buildAndPush() asynchronously and sends SSE events
 * on progress, completion, and failure.
 */

import * as fs from 'fs';

import { createLogger, errorMessage, extractDbError } from '@mwashburn160/api-core';
import type { QuotaService } from '@mwashburn160/api-core';
import type { SSEManager } from '@mwashburn160/api-server';
import { Config, db, schema, AccessModifier, ComputeType, PluginType } from '@mwashburn160/pipeline-core';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import IORedis from 'ioredis';

import { buildAndPush } from '../helpers/docker-build';
import type { RegistryInfo } from '../helpers/docker-build';

const logger = createLogger('plugin-build-queue');

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

/** Build request data stored in the BullMQ job. */
interface BuildRequestData {
  contextDir: string;
  dockerfile: string;
  imageTag: string;
  registry: RegistryInfo;
}

/** Plugin record data stored in the BullMQ job for DB insertion. */
interface PluginRecordData {
  orgId: string;
  name: string;
  description: string | null;
  version: string;
  metadata: Record<string, string | number | boolean>;
  pluginType: string;
  computeType: string;
  primaryOutputDirectory: string | null;
  dockerfile: string | null;
  env: Record<string, string>;
  keywords: string[];
  installCommands: string[];
  commands: string[];
  imageTag: string;
  accessModifier: string;
}

/** Data stored in each BullMQ job. */
export interface PluginBuildJobData {
  requestId: string;
  orgId: string;
  userId: string;
  authToken: string;
  buildRequest: BuildRequestData;
  pluginRecord: PluginRecordData;
}

// ---------------------------------------------------------------------------
// Queue name & singleton state
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'plugin-build';

let connection: IORedis | null = null;
let queue: Queue<PluginBuildJobData> | null = null;
let worker: Worker<PluginBuildJobData> | null = null;

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

function getConnection(): IORedis {
  if (!connection) {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);

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
// Queue
// ---------------------------------------------------------------------------

/** Get (or create) the shared BullMQ queue for plugin builds. */
export function getQueue(): Queue<PluginBuildJobData> {
  if (!queue) {
    queue = new Queue<PluginBuildJobData>(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600 }, // keep completed jobs 1 hour
        removeOnFail: { age: 86400 }, // keep failed jobs 24 hours
      },
    });
  }
  return queue;
}

// ---------------------------------------------------------------------------
// Worker
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
export function waitForWorkerReady(timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isWorkerReady()) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`Worker not ready after ${timeoutMs}ms`));
    }, timeoutMs);

    worker?.on('ready', () => {
      clearTimeout(timer);
      resolve();
    });
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

  const { concurrency } = Config.get().pluginBuild;

  worker = new Worker<PluginBuildJobData>(
    QUEUE_NAME,
    async (job: Job<PluginBuildJobData>) => {
      const { requestId, orgId, userId, authToken, buildRequest, pluginRecord } = job.data;

      sseManager.send(requestId, 'INFO', 'Build started', {
        jobId: job.id,
        imageTag: pluginRecord.imageTag,
      });

      try {
        // 1. Build and push Docker image (async — does NOT block event loop)
        const { fullImage } = await buildAndPush(buildRequest);

        sseManager.send(requestId, 'INFO', 'Image pushed', { fullImage });

        // 2. Persist to database
        const result = await db.transaction(async (tx) => {
          await tx
            .update(schema.plugin)
            .set({
              isDefault: false,
              updatedAt: new Date(),
              updatedBy: userId,
            })
            .where(eq(schema.plugin.name, pluginRecord.name));

          const [inserted] = await tx
            .insert(schema.plugin)
            .values({
              ...pluginRecord,
              pluginType: pluginRecord.pluginType as PluginType,
              computeType: pluginRecord.computeType as ComputeType,
              accessModifier: pluginRecord.accessModifier as AccessModifier,
              isDefault: true,
              isActive: true,
              createdBy: userId,
            })
            .returning();

          return inserted;
        });

        // 3. Increment quota (fire-and-forget)
        void quotaService.increment(orgId, 'plugins', authToken);

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
  return worker;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/** Close worker, queue, and Redis connections. */
export async function shutdownQueue(): Promise<void> {
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
