// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RedisCacheClient } from './cache-service.js';
import type { TokenRevocationStore } from '../middleware/auth.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('token-revocation');

/**
 * Redis key namespace for the per-user current `tokenVersion`. The platform
 * PUBLISHES to this key on every privilege change; the stateless services READ
 * it in `requireAuth` (via {@link createRedisTokenRevocationStore}) to reject
 * tokens minted before that change. Publisher and readers MUST share this exact
 * prefix — hence both helpers live here, in one place.
 */
export const TOKEN_REVOCATION_KEY_PREFIX = 'authrev:tv:';

/** The revocation key for a user id. */
export function tokenRevocationKey(userId: string): string {
  return `${TOKEN_REVOCATION_KEY_PREFIX}${userId}`;
}

/**
 * Build a {@link TokenRevocationStore} backed by a Redis client, for a stateless
 * service to register via `setTokenRevocationStore`. Reads the current
 * `tokenVersion` the platform published for the user.
 *
 * Fail-open by contract: a miss, a parse failure, or a Redis error all yield
 * `null` (— `requireAuth` treats that as "no known revocation"), so a Redis
 * outage degrades to the pre-existing behaviour rather than locking users out.
 */
export function createRedisTokenRevocationStore(redis: RedisCacheClient): TokenRevocationStore {
  return {
    async getCurrentVersion(userId: string): Promise<number | null> {
      try {
        const raw = await redis.get(tokenRevocationKey(userId));
        if (raw === null || raw === undefined || raw.trim() === '') return null;
        // Strict integer parse: `Number` (unlike `parseInt`) rejects trailing
        // garbage ("5abc" → NaN), so a corrupted entry fails open (null → "not
        // revoked") rather than being read as a bogus version. The empty-string
        // guard above matters because `Number('')` is 0, not NaN.
        const n = Number(raw);
        return Number.isInteger(n) ? n : null;
      } catch (err) {
        logger.debug('Token-revocation read failed (fail-open)', {
          userId, error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
}

/**
 * Publish a user's current `tokenVersion` so the stateless services see the
 * revocation immediately (platform side). Best-effort — never throws; a failure
 * just means the services fall back to natural token expiry for this change.
 *
 * The key is written with a TTL equal to the access-token lifetime: any token
 * that could still carry an older version has expired by the time the entry
 * lapses, so an expired entry can never cause a false "revoked" nor a missed one.
 *
 * @param redis - the platform's Redis client
 * @param userId - the user whose sessions changed
 * @param tokenVersion - the user's NEW (post-increment) tokenVersion
 * @param ttlSeconds - access-token lifetime in seconds
 */
export async function publishTokenRevocation(
  redis: RedisCacheClient,
  userId: string,
  tokenVersion: number,
  ttlSeconds: number,
): Promise<void> {
  try {
    // ioredis-style variadic SET with expiry: SET key val EX ttl.
    await redis.set(tokenRevocationKey(userId), String(tokenVersion), 'EX', Math.max(1, Math.floor(ttlSeconds)));
  } catch (err) {
    logger.warn('Token-revocation publish failed (services fall back to token expiry)', {
      userId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
