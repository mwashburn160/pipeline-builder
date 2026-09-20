// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createEnvRedisClient, incrWindow, type RedisEvalClient, errorMessage } from '@pipeline-builder/api-core';

const logger = createLogger('token-rate-limit');

/**
 * Rate limit on the public, unauth'd `/token` endpoint. Every request must pass
 * TWO fixed-window buckets:
 *
 * 1. **(source-ip, username)** — never the password. Keying on the password (the
 *    old behaviour) meant a credential-stuffing client that varied the password on
 *    every attempt minted a FRESH bucket each time, so the cap never engaged and
 *    `/token` became an amplifier for guessing against platform's `/auth/login`
 *    (auth-resolver Path 2). Folding varied passwords into ONE bucket per
 *    (ip, username) makes the cap bind on a stuffing run against one account.
 * 2. **source-ip alone** — without it, password SPRAYING (one common password
 *    tried against many usernames) gets a fresh (ip, username) bucket per
 *    username and is never capped. The per-IP cap is higher than the per-user
 *    cap so a NAT'd CI fleet pulling as many distinct accounts still fits.
 *
 * Backing store:
 * - **Redis** (shared env wiring, same as the idempotency / SSE stores) when
 *   `REDIS_URL`/`REDIS_SENTINELS` is configured, so the cap is enforced ACROSS pods
 *   rather than per-replica (`cap × replicas`). Fixed-window `INCR` + `PEXPIRE`.
 * - **In-memory** fallback when Redis isn't configured, or for a single call
 *   when a Redis command fails (fail back to per-pod protection, not wide-open).
 *   The memory map sweeps ALL expired buckets on window rollover and is hard-
 *   capped so short-lived identities can't grow it unbounded.
 *
 * Defaults: 60 requests / 60s per (ip, username); 300 / 60s per ip. Override via env.
 */
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.REGISTRY_TOKEN_RATE_LIMIT_MAX || '60', 10);
const RATE_LIMIT_IP_MAX = parseInt(process.env.REGISTRY_TOKEN_RATE_LIMIT_IP_MAX || '300', 10);
/** Hard cap on distinct in-memory buckets (fallback path only). */
const MAX_MEMORY_BUCKETS = parseInt(process.env.REGISTRY_TOKEN_RATE_LIMIT_MAX_BUCKETS || '10000', 10);

const REDIS_KEY_PREFIX = 'reg:tokrl:';

// Constructed once from the shared env Redis. Null when Redis isn't configured
// → the memory fallback owns enforcement (per-pod, still bounded).
const redis = createEnvRedisClient<RedisEvalClient>('token-rate-limit');
if (redis) logger.info('Redis-backed /token rate limiter initialized');

const memBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Build the per-(ip, username) bucket key. Password is intentionally EXCLUDED so
 * varying it can't spawn a fresh bucket per attempt.
 */
function userBucketKey(sourceIp: string, username: string): string {
  return `u:${sourceIp}|${username}`;
}

/** Build the per-source-ip bucket key (distinct `ip:` namespace from the user buckets). */
function ipBucketKey(sourceIp: string): string {
  return `ip:${sourceIp}`;
}

/** In-memory fixed-window check. Returns true when the request is allowed. */
function checkMemory(key: string, max: number): boolean {
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
  if (bucket.count >= max) return false;
  bucket.count++;
  return true;
}

/**
 * One fixed-window bucket check. Prefers the shared Redis counter (cross-pod) and
 * falls back to the in-memory counter on a missing/erroring Redis so an outage
 * degrades to per-pod protection rather than removing the cap entirely.
 */
async function checkBucket(key: string, max: number): Promise<boolean> {
  if (redis) {
    try {
      // Atomic INCR + window TTL: a separate INCR then PEXPIRE could lose the
      // expiry and leave the bucket over its cap forever.
      const count = await incrWindow(redis, `${REDIS_KEY_PREFIX}${key}`, RATE_LIMIT_WINDOW_MS);
      return count <= max;
    } catch (err) {
      logger.warn('Redis /token rate-limit check failed; falling back to in-memory', {
        error: errorMessage(err),
      });
    }
  }
  return checkMemory(key, max);
}

/**
 * Returns true when a `/token` request from `sourceIp` for `username` is allowed:
 * BOTH the per-IP bucket (anti-spraying) and the per-(ip, username) bucket
 * (anti-stuffing) must be under their caps. The IP bucket is checked first; a
 * request it rejects does not also consume the user bucket.
 */
export async function checkTokenRateLimit(sourceIp: string, username: string): Promise<boolean> {
  if (!(await checkBucket(ipBucketKey(sourceIp), RATE_LIMIT_IP_MAX))) return false;
  return checkBucket(userBucketKey(sourceIp, username), RATE_LIMIT_MAX);
}
