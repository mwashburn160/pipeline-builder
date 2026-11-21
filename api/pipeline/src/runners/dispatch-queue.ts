// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `runner-dispatch` BullMQ queue on the service's Redis (the same
 * connection resolution as the plugin build queue): one job per run request,
 * `jobId = requestId`, so a re-enqueue of a request already waiting is a no-op.
 * A job delivers once; a retry is the SAME job moved to delayed (BullMQ's
 * DelayedError pattern), so the request id stays its job id until it finishes.
 * Per-pipeline serialization is the dispatcher's lock, not the queue's.
 *
 * Plus the sweep (expiry, health pings, the signing-key lifecycle, the unhealthy
 * gauge), leader-locked so one replica runs it per window. Always started:
 * runners are the only execution path, and availability (the pause toggle,
 * secret encryption) is checked per job and per sweep.
 */

import { createLogger, createRedisClient, createScheduler, errorMessage, leaderLockKey, resolveRedisConnection, type Scheduler, type SchedulerOptions } from '@pipeline-builder/api-core';
import { DelayedError, Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { primeRunnerMetrics } from './delivery.js';
import { runnerDeps, setDispatchQueue, type DispatchQueue, type RunnerDeps } from './deps.js';
import { dropUnhealthyGauge, processDelivery, runSweep } from './lifecycle.js';
import { runnerSettings } from './vocabulary.js';

const logger = createLogger('runner-dispatch');

export const RUNNER_DISPATCH_QUEUE = 'runner-dispatch';
const SWEEP_INTERVAL_MS = 15_000;

interface JobData { requestId: string }

/**
 * How long an enqueue may wait on Redis. The BullMQ connection retries forever
 * (`maxRetriesPerRequest: null`), so with Redis down an `add` would never
 * settle and hold the user's Re-run open; the request row stays `queued` and
 * the sweep enqueues it once Redis is back.
 */
const ENQUEUE_TIMEOUT_MS = 3_000;

/** A {@link DispatchQueue} over a BullMQ queue. */
export function bullDispatchQueue(queue: Pick<Queue<JobData>, 'add'>, timeoutMs = ENQUEUE_TIMEOUT_MS): DispatchQueue {
  return {
    async enqueue(requestId, delayMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`runner dispatch enqueue timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        await Promise.race([queue.add('deliver', { requestId }, {
          jobId: requestId,
          ...(delayMs && delayMs > 0 ? { delay: delayMs } : {}),
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 1,
        }), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The worker's processor: deliver once; on "retry in N ms" move the job to
 * delayed and throw DelayedError so BullMQ keeps it (same id) for later.
 */
export function dispatchProcessor(deps: () => RunnerDeps = runnerDeps) {
  return async (job: Pick<Job<JobData>, 'data' | 'moveToDelayed'>, token?: string): Promise<void> => {
    const result = await processDelivery(deps(), job.data.requestId);
    if (result.done) return;
    await job.moveToDelayed(deps().now() + result.retryInMs, token);
    throw new DelayedError();
  };
}

/**
 * The sweep's scheduler: leader-locked, one replica per cycle. The leader
 * publishes the unhealthy-runner gauge; a replica whose cycle is skipped
 * (another holds the lock) drops its own copy, so only the current leader's
 * count is exported.
 */
export function runnerSweepOptions(deps: () => RunnerDeps = runnerDeps): SchedulerOptions {
  return {
    name: 'runner-sweep',
    intervalMs: SWEEP_INTERVAL_MS,
    startupDelayMs: 5_000,
    lock: { key: leaderLockKey('pipeline', 'runner-sweep'), ttlMs: 60_000 },
    run: async () => { await runSweep(deps()); },
    onSkipped: () => { dropUnhealthyGauge(deps()); },
  };
}

export interface RunnerDispatch { stop(): Promise<void> }

/** Start the queue, worker and sweep. */
export function startRunnerDispatch(): RunnerDispatch {
  const resolved = resolveRedisConnection();
  let worker: Worker<JobData> | null = null;
  let queue: Queue<JobData> | null = null;
  let conn: Redis | null = null;
  if (resolved) {
    conn = createRedisClient<Redis>(resolved, 'runner-dispatch-queue', { maxRetriesPerRequest: null });
    queue = new Queue<JobData>(RUNNER_DISPATCH_QUEUE, { connection: conn as ConnectionOptions });
    setDispatchQueue(bullDispatchQueue(queue));
    worker = new Worker<JobData>(RUNNER_DISPATCH_QUEUE, dispatchProcessor(), { connection: conn as ConnectionOptions, concurrency: runnerSettings().dispatchConcurrency });
    worker.on('failed', (job, err) => logger.warn('Runner dispatch job failed', { requestId: job?.data.requestId, error: errorMessage(err) }));
  } else {
    // No Redis: deliver in-process (single replica).
    setDispatchQueue(inProcessDispatchQueue());
    logger.warn('No Redis configured: runner dispatch runs in-process (single replica only)');
  }
  primeRunnerMetrics(runnerDeps());
  const sweep: Scheduler = createScheduler(runnerSweepOptions());
  sweep.start();
  logger.info('Runner dispatch started', { queue: RUNNER_DISPATCH_QUEUE, redis: !!resolved });
  return {
    async stop() {
      sweep.stop();
      await worker?.close();
      await queue?.close();
      conn?.disconnect();
    },
  };
}

/** A timer-driven queue for a Redis-less single replica (and tests). */
export function inProcessDispatchQueue(deps: () => RunnerDeps = runnerDeps, schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms).unref?.(); }): DispatchQueue {
  const pending = new Set<string>();
  const run = (requestId: string, delayMs: number) => {
    if (pending.has(requestId)) return;
    pending.add(requestId);
    schedule(() => {
      pending.delete(requestId);
      processDelivery(deps(), requestId)
        .then((r) => { if (!r.done) run(requestId, r.retryInMs); })
        .catch((err) => logger.warn('In-process runner delivery failed', { requestId, error: errorMessage(err) }));
    }, delayMs);
  };
  return { async enqueue(requestId, delayMs = 0) { run(requestId, delayMs); } };
}
