// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lazily-constructed Redis client accessor for the platform.
 *
 * Platform is otherwise fully Mongo-backed; the ONE thing it needs Redis for is
 * PUBLISHING revocation entries that the stateless services read (a user's
 * `tokenVersion`, and ended impersonation sessions — see
 * helpers/session-revocation.ts).
 *
 * The client is built with api-core's `createEnvRedisClient`, the same
 * resolution every reading service uses (`REDIS_URL` or `REDIS_SENTINELS`). A
 * writer and its readers must resolve Redis the same way, or revocation silently
 * does nothing.
 *
 * Graceful degradation: when no Redis is configured the accessor returns
 * `undefined` and callers treat the publish as not having happened.
 */

import { createEnvRedisClient, createLogger } from '@pipeline-builder/api-core';
import type { RedisCacheClient } from '@pipeline-builder/api-core';

const logger = createLogger('redis-client');

/**
 * Memoized accessor state:
 * - `undefined`  → not yet attempted (build on first call)
 * - `null`       → attempted and unavailable (not configured / load failure) — stay off
 * - a client     → live ioredis instance
 */
let cached: RedisCacheClient | null | undefined;

/**
 * Return the shared Redis client, or `undefined` when Redis is not configured /
 * unavailable. Never throws.
 */
export async function getRedisClient(): Promise<RedisCacheClient | undefined> {
  if (cached !== undefined) return cached ?? undefined;
  cached = createEnvRedisClient<RedisCacheClient>('platform-revocation-publisher');
  if (cached) {
    logger.info('Redis client initialized for revocation publishing');
  } else {
    logger.warn('No Redis configured (REDIS_URL / REDIS_SENTINELS) — revocations will not reach other services');
  }
  return cached ?? undefined;
}

/** Test-only: reset the memoized client so a suite can re-exercise construction. */
export function __resetRedisClientForTests(): void {
  cached = undefined;
}
