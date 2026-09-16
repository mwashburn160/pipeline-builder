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
 * The client is built with api-core's `createEnvRedisClient` — the SAME
 * resolution the reading services use: `REDIS_SENTINELS` (HA), then `REDIS_URL`,
 * then `REDIS_HOST`/`REDIS_PORT`. That match is the whole point. The publisher
 * previously read `REDIS_URL` only, which no deployment target sets — the targets
 * configure `REDIS_HOST` (docker, minikube) or `REDIS_SENTINELS` (ec2, eks) — so
 * platform never published anything and every service's revocation check read
 * keys that were never written. A writer and its readers must resolve Redis the
 * same way, or revocation silently does nothing.
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
    logger.warn('No Redis configured (REDIS_SENTINELS / REDIS_URL / REDIS_HOST) — revocations will not reach other services');
  }
  return cached ?? undefined;
}

/** Test-only: reset the memoized client so a suite can re-exercise construction. */
export function __resetRedisClientForTests(): void {
  cached = undefined;
}
