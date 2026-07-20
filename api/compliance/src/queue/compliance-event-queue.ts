// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import type { ComplianceEvent, LockRedis, RedisCacheClient } from '@pipeline-builder/api-core';
import { Queue, Worker } from 'bullmq';

const logger = createLogger('compliance-event-queue');

const QUEUE_NAME = 'compliance-events';
const DLQ_NAME = `${QUEUE_NAME}-dlq`;
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const connection = { host: REDIS_HOST, port: REDIS_PORT };

const queue = new Queue<ComplianceEvent>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
});

/**
 * Dead-letter payload: the original compliance event plus the forensic
 * metadata (why it died, how many attempts it burned, when it landed here).
 */
export interface ComplianceEventDeadLetter extends ComplianceEvent {
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
}

let worker: Worker<ComplianceEvent> | null = null;
let deadLetterQueue: Queue<ComplianceEventDeadLetter> | null = null;

/**
 * Dead-letter queue for compliance events that exhaust all retries.
 *
 * This is a governance path: a persistently-failing entity that just fell off
 * the main queue after `attempts:3` would stop being re-validated and silently
 * slip through non-compliant. Mirroring the plugin build queue's DLQ, the
 * final-failure path parks the job here — `removeOnComplete/removeOnFail:false`
 * keeps it forever for forensics and manual replay — rather than letting BullMQ
 * evict it from the bounded (`removeOnFail:{count:500}`) failed set and vanish.
 *
 * Lazily constructed so importing this module (readiness probe, `enqueue`)
 * doesn't open a second Redis connection until a job actually dead-letters.
 */
export function getDeadLetterQueue(): Queue<ComplianceEventDeadLetter> {
  if (!deadLetterQueue) {
    deadLetterQueue = new Queue<ComplianceEventDeadLetter>(DLQ_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
  }
  return deadLetterQueue;
}

/**
 * Move an exhausted compliance-event job to the dead-letter queue. Called from
 * the worker's `failed` handler only once retries are spent (final attempt), so
 * a still-retrying job isn't dead-lettered prematurely. Best-effort: a DLQ
 * `add` failure is logged, never thrown, so it can't crash the worker.
 */
async function moveToDeadLetter(job: { name?: string; id?: string; data: ComplianceEvent; attemptsMade: number }, reason: string): Promise<void> {
  const event = job.data;
  try {
    await getDeadLetterQueue().add(`dlq:${job.name ?? event.eventType}`, {
      ...event,
      failedReason: reason,
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    });
    logger.error('Compliance event dead-lettered after exhausting retries', {
      jobId: job.id,
      eventType: event.eventType,
      target: event.target,
      entityId: event.entityId,
      attemptsMade: job.attemptsMade,
    });
  } catch (dlqErr) {
    // Last resort: even the DLQ add failed. Log loudly with the full event so
    // the job is at least recoverable from logs rather than truly lost.
    logger.error('Failed to dead-letter compliance event', {
      jobId: job.id,
      event,
      reason,
      error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
    });
  }
}

/**
 * Enqueue a compliance event for async processing via BullMQ.
 */
export async function enqueue(event: ComplianceEvent): Promise<void> {
  await queue.add(`${event.eventType}:${event.target}:${event.entityId}`, event);
}

/**
 * The queue's underlying ioredis client, for the service's readiness probe.
 * BullMQ exposes it as a `Promise<RedisClient>`; pass this getter to
 * `redisHealthCheck` so `/ready` reflects the real redis compliance depends on.
 */
export function getQueueRedis(): Promise<{ ping(): Promise<string> }> {
  return queue.client as unknown as Promise<{ ping(): Promise<string> }>;
}

/**
 * The same ioredis client, typed for `withLeaderLock` (SET NX PX). Used by the
 * digest scheduler so only one pod flushes per window across replicas.
 */
export function getLockRedis(): Promise<LockRedis> {
  return queue.client as unknown as Promise<LockRedis>;
}

/**
 * The BullMQ connection adapted to api-core's synchronous `RedisCacheClient`
 * shape, so the boot-time token-revocation reader can REUSE the single redis
 * connection compliance already maintains rather than opening its own. BullMQ
 * hands the ioredis client back as a `Promise`; each call resolves it (the
 * client is memoised after first connect, so this is effectively free). Only
 * `.get()` is exercised by the revocation reader; the rest satisfy the interface.
 */
export function getRevocationRedis(): RedisCacheClient {
  const client = () => queue.client as unknown as Promise<RedisCacheClient>;
  return {
    get: async (key) => (await client()).get(key),
    set: async (key, value, ...args) => (await client()).set(key, value, ...args),
    del: async (...keys) => (await client()).del(...keys),
    keys: async (pattern) => (await client()).keys(pattern),
  };
}

/**
 * Start the BullMQ worker that processes compliance events.
 * Calls the provided handler for each event.
 */
export function startComplianceWorker(
  handler: (event: ComplianceEvent) => Promise<void>,
  concurrency = 5,
): void {
  if (worker) return;

  worker = new Worker<ComplianceEvent>(QUEUE_NAME, async (job) => {
    const event = job.data;
    logger.debug('Processing compliance event', {
      jobId: job.id,
      eventType: event.eventType,
      target: event.target,
      entityId: event.entityId,
    });
    await handler(event);
  }, { connection, concurrency });

  worker.on('failed', (job, err) => {
    logger.warn('Compliance event job failed', {
      jobId: job?.id,
      error: err.message,
      attemptsMade: job?.attemptsMade,
    });
    if (!job) return;
    // Only dead-letter once the retry budget is spent; earlier failures still
    // have BullMQ retries left. Keeping this a fire-and-forget void keeps the
    // (sync) event listener from swallowing the promise while `moveToDeadLetter`
    // owns its own error handling.
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;
    void moveToDeadLetter(job, err.message);
  });

  worker.on('completed', (job) => {
    logger.debug('Compliance event job completed', { jobId: job.id });
  });

  worker.on('error', (err) => {
    logger.error('Compliance event worker error', { error: err.message });
  });

  logger.info('Compliance event worker started', { concurrency, queue: QUEUE_NAME });
}

// Queue-level error handler
queue.on('error', (err) => {
  logger.error('Compliance event queue error', { error: err.message });
});

/**
 * Gracefully shut down the worker and queue.
 */
export async function stopComplianceWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  await queue.close();
  if (deadLetterQueue) {
    await deadLetterQueue.close();
    deadLetterQueue = null;
  }
  logger.info('Compliance event worker stopped');
}
