// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { acquireSharedEnvLock, releaseSharedEnvLock, withLeaderLock, type LockRedis } from './leader-lock.js';
import { createLogger } from '../utils/logger.js';
import { errorMessage } from '../utils/response.js';

/**
 * Optional cross-pod single-runner lock for a scheduler's cycle. Without
 * `redis` the scheduler uses the process's shared env-configured lock client
 * (taken on `start`, released on `stop`); when Redis isn't configured the cycle
 * runs on every pod, so the work it wraps must stay safe to run concurrently.
 * A supplied `redis` factory is resolved per cycle (e.g. a BullMQ connection).
 */
export interface SchedulerLock {
  key: string;
  ttlMs: number;
  redis?: () => LockRedis;
}

export interface SchedulerOptions {
  /** Log label (also the logger name). */
  name: string;
  /** Interval between cycles (ms). */
  intervalMs: number;
  /** The work to run each cycle. Errors are caught + logged, never thrown. */
  run: () => Promise<void>;
  /** Run a cycle immediately when started. Default true. */
  runOnStart?: boolean;
  /** Delay before the first cycle (and before the interval begins), ms.
   *  Default 0. Lets a service wait for dependencies to come up. */
  startupDelayMs?: number;
  /** When set, each cycle runs only on the pod that wins this lock — so with
   *  multiple replicas only one runs per window. */
  lock?: SchedulerLock;
}

export interface Scheduler {
  /** Start the timer. Idempotent — repeated calls are no-ops. */
  start(): void;
  /** Stop the timer (and cancel a pending startup delay). Safe before start. */
  stop(): void;
}

/**
 * A periodic background job: a single unref'd `setInterval` with start-once
 * semantics, error isolation (a throwing cycle is logged, never crashes the
 * loop), an optional startup delay, and an optional cross-pod leader lock.
 *
 * Replaces the hand-rolled timer/`unref`/`catch`/start-stop boilerplate that
 * each scheduler (scan, digest, registry GC, billing lifecycle) repeated, and
 * makes the leader lock available to all of them uniformly.
 */
export function createScheduler(opts: SchedulerOptions): Scheduler {
  const log = createLogger(opts.name);
  let interval: ReturnType<typeof setInterval> | null = null;
  let startup: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;
  /** The shared env client this scheduler holds a reference on (own-client locks don't). */
  let envLock: LockRedis | null = null;
  let holdsEnvLock = false;

  const cycle = async (): Promise<void> => {
    // Same-pod re-entrancy guard: setInterval doesn't await the async cycle, so
    // a cycle slower than intervalMs would otherwise overlap ITSELF on this pod
    // (double-processing, duplicate side effects). The optional leader lock only
    // guards CROSS-pod overlap; this guards same-pod. A skipped tick just runs on
    // the next interval.
    if (running) {
      log.debug('Cycle skipped — previous cycle still running (same-pod re-entrancy)');
      return;
    }
    running = true;
    try {
      const redis = opts.lock ? (opts.lock.redis ? opts.lock.redis() : envLock) : null;
      if (opts.lock && redis) {
        const ran = await withLeaderLock(redis, opts.lock.key, opts.lock.ttlMs, opts.run);
        if (!ran) log.debug('Cycle skipped — another pod holds the lock');
      } else {
        await opts.run();
      }
    } catch (err) {
      log.error('Scheduler cycle failed', { error: errorMessage(err) });
    } finally {
      running = false;
    }
  };

  const begin = (): void => {
    if (stopped) return; // stop() called during the startup delay
    if (opts.runOnStart !== false) void cycle();
    interval = setInterval(() => void cycle(), opts.intervalMs);
    interval.unref();
  };

  return {
    start(): void {
      if (interval || startup) return;
      stopped = false;
      if (opts.lock && !opts.lock.redis && !holdsEnvLock) {
        envLock = acquireSharedEnvLock();
        holdsEnvLock = true;
      }
      if (opts.startupDelayMs && opts.startupDelayMs > 0) {
        startup = setTimeout(() => { startup = null; begin(); }, opts.startupDelayMs);
        startup.unref();
      } else {
        begin();
      }
      log.info('Scheduler started', { intervalMs: opts.intervalMs, locked: !!opts.lock && (!!opts.lock.redis || !!envLock) });
    },
    stop(): void {
      stopped = true;
      if (startup) { clearTimeout(startup); startup = null; }
      if (interval) { clearInterval(interval); interval = null; }
      if (holdsEnvLock) {
        holdsEnvLock = false;
        envLock = null;
        void releaseSharedEnvLock();
      }
      log.info('Scheduler stopped');
    },
  };
}
