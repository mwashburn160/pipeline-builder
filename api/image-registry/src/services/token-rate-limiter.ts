// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createEnvRedisClient } from '@pipeline-builder/api-core';

const logger = createLogger('token-rate-limit');

/**
 * Rate limit on the public, unauth'd `/token` endpoint.
 *
 * The bucket key is deliberately COARSE — `(source-ip, username)`, never the
 * password. Keying on the password (the old behaviour) meant a credential-
 * stuffing client that varied the password on every attempt minted a FRESH
 * bucket each time, so the cap never engaged and `/token` became an
 * amplifier for guessing against platform's `/auth/login` (auth-resolver
 * Path 2). Folding varied passwords into ONE bucket per (ip, username) is what
 * makes the cap actually bind on a stuffing run.
 *
 * Backing store:
 * - **Redis** (shared env wiring, same as the idempotency / SSE stores) when
 *   `REDIS_URL`/`REDIS_HOST` is configured, so the cap is enforced ACROSS pods
 *   rather than per-replica (`cap × replicas`). Fixed-window `INCR` + `PEXPIRE`.
 * - **In-memory** fallback when Redis isn't configured, or for a single call
 *   when a Redis command fails (fail back to per-pod protection, not wide-open).
 *   The memory map sweeps ALL expired buckets on window rollover and is hard-
 *   capped so short-lived identities can't grow it unbounded.
 *
 * Defaults: 60 requests / 60s. Override via env.
 */
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.REGISTRY_TOKEN_RATE_LIMIT_MAX || '60', 10);
/** Hard cap on distinct in-memory buckets (fallback path only). */
const MAX_MEMORY_BUCKETS = parseInt(process.env.REGISTRY_TOKEN_RATE_LIMIT_MAX_BUCKETS || '10000', 10);

const REDIS_KEY_PREFIX = 'reg:tokrl:';

/** Minimal ioredis surface the fixed-window counter needs. */
interface RedisRateClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
}

// Constructed once from the shared env Redis. Null when Redis isn't configured
// → the memory fallback owns enforcement (per-pod, still bounded).
const redis = createEnvRedisClient<RedisRateClient>('token-rate-limit');
if (redis) logger.info('Redis-backed /token rate limiter initialized');

const memBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Build the coarse bucket key. Password is intentionally EXCLUDED so varying it
 * can't spawn a fresh bucket per attempt. Both components are folded in so a
 * shared-NAT source or a reused username each get their own bucket.
 */
export function rateLimitKey(sourceIp: string, username: string): string {
  return `${sourceIp}|${username}`;
}

/** In-memory fixed-window check. Returns true when the request is allowed. */
function checkMemory(key: string): boolean {
  const now = Date.now();
  const bucket = memBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    // Sweep ALL expired buckets on window rollover (not just one) so the map
    // can't accumulate stale short-lived identities between sweeps.
    if (memBuckets.size > 0) {
      for (const [k, v] of memBuckets) if (v.resetAt <= now) memBuckets.delete(k);
    }
    // Hard cap: if still full after the sweep, evict the oldest (insertion
    // order) so a burst of distinct identities can't grow the map unbounded.
    if (memBuckets.size >= MAX_MEMORY_BUCKETS) {
      const oldest = memBuckets.keys().next().value;
      if (oldest !== undefined) memBuckets.delete(oldest);
    }
    memBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count++;
  return true;
}

/**
 * Returns true when the request is allowed; false when over the cap. Prefers
 * the shared Redis counter (cross-pod) and falls back to the in-memory counter
 * on a missing/erroring Redis so an outage degrades to per-pod protection
 * rather than removing the cap entirely.
 */
export async function checkTokenRateLimit(key: string): Promise<boolean> {
  if (redis) {
    try {
      const redisKey = `${REDIS_KEY_PREFIX}${key}`;
      const count = await redis.incr(redisKey);
      // Set the window TTL only on the first increment; subsequent hits ride the
      // existing expiry so the window is fixed, not sliding-per-request.
      if (count === 1) await redis.pexpire(redisKey, RATE_LIMIT_WINDOW_MS);
      return count <= RATE_LIMIT_MAX;
    } catch (err) {
      logger.warn('Redis /token rate-limit check failed; falling back to in-memory', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return checkMemory(key);
}
