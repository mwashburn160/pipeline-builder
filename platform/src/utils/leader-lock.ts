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
 * connection. When Redis is UNSET the wrapper runs the body on every pod, which
 * the sweeps' own idempotency/atomicity keeps
 * safe (the lock is an optimization + a destructive-work de-duplicator, not a
 * correctness prerequisite).
 */

import { createLogger, withLeaderLock, type LockRedis } from '@pipeline-builder/api-core';
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
 * @param key    stable lock key (e.g. `platform:leader:org-purge`)
 * @param ttlMs  lock lifetime — must comfortably exceed one sweep's duration
 * @param fn     the sweep body to run at most once per window fleet-wide
 */
export async function runWithLeaderLock(
  key: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const guarded = async (): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      logger.error('Background job failed', { key, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const redis = await getRedisClient();
  if (!redis) {
    // No Redis configured — run on this pod.
    await guarded();
    return true;
  }
  // getRedisClient returns a real ioredis instance (typed as RedisCacheClient);
  // it exposes set/get/del/eval, satisfying LockRedis including the atomic CAS
  // release used by withLeaderLock, which itself never rejects on Redis errors.
  return withLeaderLock(redis as unknown as LockRedis, key, ttlMs, guarded);
}
