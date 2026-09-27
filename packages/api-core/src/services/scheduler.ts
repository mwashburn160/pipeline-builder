// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { acquireSharedEnvLock, releaseSharedEnvLock, withLeaderLock, type LeaderLockRun, type LockRedis } from './leader-lock.js';
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
  /**
   * The work to run each cycle. Errors are caught + logged, never thrown.
   *
   * `run.signal` is aborted when a leader-locked cycle LOSES its lock mid-run, or
   * when `stop()` is called. A job that iterates over units of work (orgs, repos,
   * entities) must check it between units and return: past a lock loss another pod
   * may be doing the same work, and on shutdown returning promptly is what
   * releases the lock instead of leaving it to expire. Unlocked schedulers get a
   * signal too — it fires on `stop()` only.
   */
  run: (run: LeaderLockRun) => Promise<void>;
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
  /**
   * Stop the timer (and cancel a pending startup delay). Safe before start.
   *
   * Also ABORTS an in-flight cycle's `run.signal` and defers closing the shared
   * lock client until that cycle settles: a running cycle used to keep its lock
   * key until the TTL lapsed, so a rolling deploy mid-run parked the job for the
   * rest of the TTL. A signal-aware `run` returns and the lock is released.
   */
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
  /** Aborted by `stop()`, so an in-flight cycle can return and release its lock. */
  let shutdown = new AbortController();
  /** The in-flight cycle, so `stop()` can wait for it before closing the client. */
  let inFlight: Promise<void> | null = null;

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
    const signal = shutdown.signal;
    try {
      const redis = opts.lock ? (opts.lock.redis ? opts.lock.redis() : envLock) : null;
      if (opts.lock && redis) {
        // withLeaderLock merges `signal` into the run's own, so `run` sees a single
        // signal for both "lock lost" and "shutting down".
        const ran = await withLeaderLock(redis, opts.lock.key, opts.lock.ttlMs, opts.run, { signal });
        if (!ran) log.debug('Cycle skipped — another pod holds the lock');
      } else {
        // Unlocked: still give the job a signal, so `stop()` can cut a long cycle
        // short rather than waiting for it during shutdown.
        await opts.run({ signal });
      }
    } catch (err) {
      log.error('Scheduler cycle failed', { error: errorMessage(err) });
    } finally {
      running = false;
    }
  };

  /** Run a cycle and publish it as `inFlight` so `stop()` can await it. */
  const runCycle = (): void => {
    const p = cycle().finally(() => { if (inFlight === p) inFlight = null; });
    inFlight = p;
  };

  const begin = (): void => {
    if (stopped) return; // stop() called during the startup delay
    if (opts.runOnStart !== false) runCycle();
    interval = setInterval(() => runCycle(), opts.intervalMs);
    interval.unref();
  };

  return {
    start(): void {
      if (interval || startup) return;
      stopped = false;
      // A restart needs a fresh controller: the previous stop() aborted the old
      // one, and an already-aborted signal would make every cycle a no-op.
      if (shutdown.signal.aborted) shutdown = new AbortController();
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
      // Ask an in-flight cycle to wind up. A signal-aware `run` returns between
      // units of work, which lets withLeaderLock's `finally` RELEASE the lock —
      // otherwise the key sat there until the TTL lapsed and the job was parked
      // fleet-wide for that long after every rolling deploy.
      if (!shutdown.signal.aborted) shutdown.abort('shutdown');
      if (holdsEnvLock) {
        holdsEnvLock = false;
        const pending = inFlight;
        envLock = null;
        // Closing the client under a running cycle kills its heartbeat and its
        // release, so wait for the cycle to settle first. Bounded by the cycle
        // itself, which is now being asked to stop.
        void (pending ? pending.catch(() => undefined) : Promise.resolve())
          .then(() => releaseSharedEnvLock());
      }
      log.info('Scheduler stopped');
    },
  };
}
