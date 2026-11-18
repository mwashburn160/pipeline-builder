// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lazily-constructed Redis client for ops-center: the cross-replica
 * cooldown locks of the auto-expand / Postgres-rung webhooks and the sweeps'
 * leader locks. Built with api-core's `createEnvRedisClient` (`REDIS_URL` or
 * `REDIS_SENTINELS`), like every service. `undefined` when no Redis is
 * configured — the mutating webhooks then refuse (fail closed) rather than act
 * without a cooldown.
 */

import { createEnvRedisClient, createLogger } from '@pipeline-builder/api-core';
import type { RedisCacheClient } from '@pipeline-builder/api-core';

const logger = createLogger('redis-client');

let cached: RedisCacheClient | null | undefined;

export async function getRedisClient(): Promise<RedisCacheClient | undefined> {
  if (cached !== undefined) return cached ?? undefined;
  cached = createEnvRedisClient<RedisCacheClient>('ops-center');
  if (!cached) logger.warn('No Redis configured (REDIS_URL / REDIS_SENTINELS) — cooldown locks and leader locks are unavailable');
  return cached ?? undefined;
}

/** Test-only: reset the memoized client so a suite can re-exercise construction. */
export function __resetRedisClientForTests(): void {
  cached = undefined;
}
