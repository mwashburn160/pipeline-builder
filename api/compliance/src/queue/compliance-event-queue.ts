import { createLogger } from '@mwashburn160/api-core';
import type { ComplianceEvent } from '@mwashburn160/api-core';
import { Queue, Worker } from 'bullmq';

const logger = createLogger('compliance-event-queue');

const QUEUE_NAME = 'compliance-events';
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

let worker: Worker<ComplianceEvent> | null = null;

/**
 * Enqueue a compliance event for async processing via BullMQ.
 */
export async function enqueue(event: ComplianceEvent): Promise<void> {
  await queue.add(`${event.eventType}:${event.target}:${event.entityId}`, event);
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
  logger.info('Compliance event worker stopped');
}
