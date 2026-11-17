// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lazily-constructed Redis client accessor for the platform.
 *
 * Platform is Mongo-backed; it uses this Redis client to PUBLISH revocation
 * entries the stateless services read (a user's `tokenVersion`, ended
 * impersonation sessions — see helpers/session-revocation.ts). Other
 * cross-replica state (rate-limit buckets, pending OAuth/SSO states, leader
 * locks, step-up single-use) resolves Redis through the same env.
 *
 * The client is built with api-core's `createEnvRedisClient`, the same
 * resolution every reading service uses (`REDIS_URL` or `REDIS_SENTINELS`). A
 * writer and its readers must resolve Redis the same way, or revocation silently
 * does nothing.
 *
 * Graceful degradation is a DEV/TEST convenience only: when no Redis is
 * configured the accessor returns `undefined` and callers treat the publish as
 * not having happened (and per-process fallbacks take over). Under
 * `NODE_ENV=production` the service refuses to boot without Redis — see
 * {@link assertRedisConfiguredForProduction} and the dependency matrix in
 * docs/authentication.md "Redis dependency".
 */

import { createEnvRedisClient, createLogger, resolveRedisConnection } from '@pipeline-builder/api-core';
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

/** True when this process runs as a production deployment. */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Refuse to boot a PRODUCTION platform with no Redis configured.
 *
 * Without Redis every cross-replica guarantee quietly degrades to per-process
 * state: rate-limit buckets become `max × replicas`, the SAML replay guard and
 * the OAuth/SSO pending states live in one pod's memory (so a replay on another
 * pod is accepted, and a callback on another pod fails), and session/token
 * revocations never reach the stateless services. None of that is acceptable
 * silently in production, so it is a boot error — dev and test keep the
 * in-memory fallbacks.
 *
 * Throws on a production env with neither `REDIS_URL` nor `REDIS_SENTINELS`;
 * an INVALID configuration already throws from `resolveRedisConnection`.
 */
export function assertRedisConfiguredForProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProductionEnv(env)) return;
  if (resolveRedisConnection(env)) return;
  throw new Error(
    'Redis is required when NODE_ENV=production: set REDIS_URL=redis://<host>:<port> (or REDIS_SENTINELS for HA). '
    + 'Rate limiting, the SAML replay guard, OAuth/SSO pending state and session revocation all depend on it '
    + '(see docs/authentication.md "Redis dependency").',
  );
}

/** Test-only: reset the memoized client so a suite can re-exercise construction. */
export function __resetRedisClientForTests(): void {
  cached = undefined;
}
