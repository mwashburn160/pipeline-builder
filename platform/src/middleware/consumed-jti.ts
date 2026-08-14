// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single-use enforcement for step-up tokens.
 *
 * Tracks a consumed `jti` for the brief window between issue and expiry. A jti
 * seen for the second time is rejected as replay.
 *
 * Storage: the shared env Redis when configured, a process-local Map otherwise.
 *   - With Redis, single-use holds ACROSS replicas: the jti is claimed with an
 *     atomic `SET key NX PX ttl`, so exactly one pod in the fleet wins the first
 *     use and every replay (any pod) loses. This closes the multi-instance
 *     replay gap where a token replayed against a DIFFERENT instance succeeded.
 *   - Without Redis (`REDIS_URL` unset) it degrades to the previous per-process
 *     Map: true single-use within one instance, best-effort across a fleet —
 *     acceptable for the 60s TTL on a single-replica deploy.
 *   - Fail-safe: a Redis error falls back to the in-memory claim for that call,
 *     so a Redis blip can never wedge step-up entirely.
 *
 * Reuses `getRedisClient()` — the SAME env Redis client the platform already
 * uses for session-revocation publishing — so no new connection/config.
 */

import { getRedisClient } from '../utils/redis-client.js';

/** Redis key namespace for a consumed step-up jti. */
const JTI_KEY_PREFIX = 'stepup:jti:';

const consumed = new Map<string, number>();

/** Evict entries whose expiry has passed. Called on every in-memory consume. */
function evictExpired(nowSeconds: number): void {
  for (const [jti, exp] of consumed) {
    if (exp <= nowSeconds) consumed.delete(jti);
  }
}

/** In-memory single-use claim (Redis-unset / Redis-error fallback). */
function consumeJtiInMemory(jti: string, expirySeconds: number, nowSeconds: number): boolean {
  evictExpired(nowSeconds);
  if (consumed.has(jti)) return false; // replay
  consumed.set(jti, expirySeconds);
  return true;
}

/**
 * Mark a jti as consumed.
 * @returns true if newly consumed (caller may proceed); false if it was
 *   already consumed or already expired (caller must reject the request).
 */
export async function consumeJti(jti: string, expirySeconds: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  if (expirySeconds <= now) return false; // expired token

  const redis = await getRedisClient();
  if (redis) {
    try {
      const ttlMs = (expirySeconds - now) * 1000;
      // Atomic claim: only the FIRST setter wins (NX); the key auto-expires with
      // the token (PX) so the consumed set never outlives what it protects.
      const res = await redis.set(`${JTI_KEY_PREFIX}${jti}`, '1', 'PX', ttlMs, 'NX');
      return res === 'OK';
    } catch {
      // Fall through to the in-memory claim (best-effort single-use).
    }
  }
  return consumeJtiInMemory(jti, expirySeconds, now);
}

/** Test-only: clear the in-memory consumed set. Don't call from production code. */
export function _resetConsumedJtiForTests(): void {
  consumed.clear();
}
