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
 * connection. When Redis is UNSET the wrapper runs the body on every pod — i.e.
 * exactly today's behavior — which the sweeps' own idempotency/atomicity keeps
 * safe (the lock is an optimization + a destructive-work de-duplicator, not a
 * correctness prerequisite).
 */

import { withLeaderLock, type LockRedis } from '@pipeline-builder/api-core';
import { getRedisClient } from './redis-client.js';

/**
 * Run `fn` under a cross-pod leader lock keyed by `key`. Returns true when this
 * pod ran the body (either it won the lock, or Redis is unset so every pod
 * runs), false when another pod holds the lock this window. Never throws for
 * lock-acquisition reasons; `fn`'s own errors propagate to the caller as before.
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
  const redis = await getRedisClient();
  if (!redis) {
    // No Redis configured — degrade to running on this pod (today's behavior).
    await fn();
    return true;
  }
  // getRedisClient returns a real ioredis instance (typed as RedisCacheClient);
  // it exposes set/get/del/eval, satisfying LockRedis including the atomic CAS
  // release used by withLeaderLock.
  return withLeaderLock(redis as unknown as LockRedis, key, ttlMs, fn);
}
