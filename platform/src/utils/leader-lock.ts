// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-pod leader lock for the platform's periodic background sweeps.
 *
 * Every platform replica runs the same timers (org-purge, invitation-reaper,
 * billing reconcile, the observability scraper). Without coordination a
 * destructive sweep — org-purge above all — runs N times in parallel across N
 * replicas, and the read-only scraper wastes N× the Mongo round-trips. This
 * wraps a sweep body in the SAME `withLeaderLock` primitive the compliance /
 * billing schedulers use, so exactly ONE pod runs each window and the lock
 * auto-expires if that pod dies mid-run.
 *
 * Reuses the platform's env Redis client (`getRedisClient`, the same client used
 * for session-revocation publishing) as the lock backend, so there is no extra
 * connection.
 *
 * WHEN REDIS IS UNSET the behaviour now depends on what the sweep does, because
 * the blanket "every pod runs, the sweeps' own idempotency keeps it safe" claim
 * was not true of all of them. `org-purge` scans for expired orgs and runs a
 * destructive cascade per org with no atomic claim, so N replicas would run the
 * SAME cascade concurrently — its idempotency covers sequential retry, not
 * concurrent execution. A sweep declares which it is:
 *
 *  - `concurrencySafe: true`  — runs on every pod without Redis (read-only
 *    scrapes, queue drains, anything whose unit of work is claimed atomically).
 *  - default (false)          — SKIPS without Redis, and says so. Better a sweep
 *    that does not run than two pods hard-deleting the same org.
 */

import { createLogger, createScheduler, withLeaderLock, DEFAULT_LEADER_LOCK_TTL_MS, type LeaderLockRun, type LockRedis, type Scheduler, errorMessage } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { getRedisClient } from './redis-client.js';

const logger = createLogger('leader-lock');

/**
 * Run `fn` under a cross-pod leader lock keyed by `key`. Returns true when this
 * pod ran the body (it won the lock, or Redis is unset so every pod runs), false
 * when another pod holds the lock or the lock couldn't be taken.
 *
 * NEVER rejects. Every caller is a timer that fires it with `void`, so a
 * rejection is an unhandled promise rejection — which exits the process. A Redis
 * blip (including the window before the first connection completes) skips the
 * run; an error thrown by `fn` is logged against `key`.
 *
 * @param key    stable lock key, built with api-core's `leaderLockKey`
 * @param ttlMs  lock lifetime — a CRASH-RECOVERY window, not a run-duration
 *               cover: withLeaderLock heartbeats for as long as `fn` runs
 * @param fn     the sweep body to run at most once per window fleet-wide
 * @param opts   `concurrencySafe` licenses the no-Redis path (see module header);
 *               `signal` is the caller's shutdown signal
 */
export async function runWithLeaderLock(
  key: string,
  ttlMs: number,
  fn: (run: LeaderLockRun) => Promise<void>,
  opts: { concurrencySafe?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  const guarded = async (run: LeaderLockRun): Promise<void> => {
    try {
      await fn(run);
    } catch (err) {
      // Counted, not just logged: a sweep that throws every cycle still returned
      // `true` from here, so with no metric it was indistinguishable from one that
      // worked. `leader_lock_acquired_total` says a pod ran; this says it failed.
      incCounter('background_sweep_failed_total', { key });
      logger.error('Background job failed', { key, error: errorMessage(err) });
    }
  };
  // Resolving the client can itself reject (a Sentinel lookup failing, say). This
  // function must NEVER reject — every caller fires it from a timer with `void`, so
  // a rejection is an unhandled rejection, which exits the process. Treat a failure
  // to resolve exactly like "no Redis".
  let redis: Awaited<ReturnType<typeof getRedisClient>> | null = null;
  try {
    redis = await getRedisClient();
  } catch (err) {
    logger.warn('Redis client resolution failed; treating as no lock available', { key, error: errorMessage(err) });
  }
  if (!redis) {
    if (!opts.concurrencySafe) {
      // Fail CLOSED. Without Redis no pod can prove it is the only one running,
      // and this sweep is not safe to run twice at once.
      incCounter('background_sweep_skipped_no_lock_total', { key });
      logger.warn('No Redis configured and this sweep is not concurrency-safe — skipping', { key });
      return false;
    }
    await guarded({ signal: opts.signal ?? new AbortController().signal });
    return true;
  }
  // getRedisClient returns a real ioredis instance (typed as RedisCacheClient);
  // it exposes set/get/del/eval, satisfying LockRedis including the atomic CAS
  // release used by withLeaderLock, which itself never rejects on Redis errors.
  return withLeaderLock(redis as unknown as LockRedis, key, ttlMs, guarded, { signal: opts.signal });
}

/**
 * A periodic platform sweep: api-core's `createScheduler` (unref'd interval,
 * start-once, error isolation, and a SAME-POD re-entrancy guard — a cycle
 * slower than its interval is skipped rather than overlapping itself) whose
 * every cycle runs under {@link runWithLeaderLock} (CROSS-POD: one replica per
 * window, lock held for the run's duration by withLeaderLock).
 *
 * The TTL is {@link DEFAULT_LEADER_LOCK_TTL_MS} and deliberately NOT derived from
 * the interval. It used to be `max(intervalMs, 60s)`, which made the
 * domain-reverify lock 24 HOURS long (its interval) — so a pod dying mid-run
 * parked that sweep for a day, and its heartbeat only checked every 8 hours.
 * Because the holder heartbeats for as long as the run takes, the TTL only needs
 * to bound crash recovery.
 */
export function createLockedSweep(opts: {
  name: string;
  lockKey: string;
  intervalMs: number;
  run: (run: LeaderLockRun) => Promise<void>;
  runOnStart?: boolean;
  /** See the module header — licenses running on every pod when Redis is unset. */
  concurrencySafe?: boolean;
}): Scheduler {
  return createScheduler({
    name: opts.name,
    intervalMs: opts.intervalMs,
    runOnStart: opts.runOnStart,
    run: async (run) => {
      await runWithLeaderLock(opts.lockKey, DEFAULT_LEADER_LOCK_TTL_MS, opts.run, {
        ...(opts.concurrencySafe !== undefined ? { concurrencySafe: opts.concurrencySafe } : {}),
        signal: run.signal,
      });
    },
  });
}
