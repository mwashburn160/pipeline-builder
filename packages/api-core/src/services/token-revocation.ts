// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RedisCacheClient } from './cache-service.js';
import { createEnvRedisClient, createRedisReadyGate, type ReadyAwareRedis } from './env-redis.js';
import type { CredentialRevocationRefs, SessionRevocationState, TokenRevocationStore } from '../middleware/revocation.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';

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
 * Redis key namespace for ended IMPERSONATION sessions, by token `jti`. Same
 * publish/read split as the tokenVersion keys above, and kept beside them for the
 * same reason: publisher and readers must agree on this exact prefix.
 */
export const SESSION_REVOCATION_KEY_PREFIX = 'authrev:jti:';

/** The revocation key for one session's token id. */
export function sessionRevocationKey(jti: string): string {
  return `${SESSION_REVOCATION_KEY_PREFIX}${jti}`;
}

/**
 * Redis key namespaces for revoking ONE credential rather than a whole user:
 *
 * - `revoke:sid:<sid>`   — one refresh-session slot (a signed-out device, a
 *                          revoked machine session). Rejects every access token
 *                          whose `sid` claim names it.
 * - `revoke:key:<keyId>` — one access key (PAT or service-account key). Rejects
 *                          the key's exchanged token (`token_use: 'api_key'`,
 *                          `jti` = key id) and anything derived from it
 *                          (`parentKeyId`).
 *
 * Platform PUBLISHES these ({@link publishCredentialRevocation}); every service
 * READS them in `requireAuth`. Presence is the whole signal — the value is `1`.
 */
export const CREDENTIAL_REVOCATION_PREFIX = {
  sid: 'revoke:sid:',
  key: 'revoke:key:',
} as const;

/** Which credential a {@link credentialRevocationKey} names. */
export type CredentialKind = keyof typeof CREDENTIAL_REVOCATION_PREFIX;

/** The revocation key for one session slot (`sid`) or one access key (`key`). */
export function credentialRevocationKey(kind: CredentialKind, id: string): string {
  return `${CREDENTIAL_REVOCATION_PREFIX[kind]}${id}`;
}

/**
 * Atomic "set if greater" for the per-user tokenVersion. A plain SET let two
 * concurrent publishes land out of order — an older version overwriting a newer
 * one silently UN-revoked every token between them. The script only ever raises
 * the stored version, and only ever lengthens the entry's TTL.
 *
 * KEYS[1] = revocation key; ARGV[1] = version; ARGV[2] = ttl seconds.
 * Returns 1 when it wrote, 0 when an equal-or-newer version was already there.
 */
export const SET_IF_GREATER_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]))
local v = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
if cur and cur >= v then
  if redis.call('TTL', KEYS[1]) < ttl then redis.call('EXPIRE', KEYS[1], ttl) end
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
return 1
`;

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
        // Redis was reachable enough to try but the read errored — this is a
        // DEGRADATION: while it persists, forced logouts / privilege revocations
        // silently stop taking effect until natural token expiry. Emit a counter
        // so `TokenRevocationFailingOpen` can alert on a SUSTAINED rate (mirrors
        // the quota_fail_open_total pattern). Not emitted for the "Redis not
        // configured" path (createEnvRedisTokenRevocationStore → null client),
        // which is a deliberate opt-out, not a degradation.
        emitCounter('token_revocation_fail_open_total', { reason: 'read-error' });
        logger.debug('Token-revocation read failed (fail-open)', {
          userId, error: errorMessage(err),
        });
        return null;
      }
    },
    async getSessionRevocation(jti: string): Promise<SessionRevocationState> {
      try {
        const raw = await redis.get(sessionRevocationKey(jti));
        return raw === null || raw === undefined ? 'live' : 'revoked';
      } catch (err) {
        // NOT fail-open, unlike getCurrentVersion above: `unavailable` rejects
        // the impersonation token. Counted so a sustained outage — which stops
        // support impersonation everywhere — is visible and alertable.
        emitCounter('session_revocation_unavailable_total', { reason: 'read-error' });
        logger.debug('Session-revocation read failed (rejecting impersonation token)', {
          error: errorMessage(err),
        });
        return 'unavailable';
      }
    },
    async isCredentialRevoked(refs: CredentialRevocationRefs): Promise<boolean> {
      const keys = [
        ...(refs.sid ? [credentialRevocationKey('sid', refs.sid)] : []),
        ...refs.keyIds.map((id) => credentialRevocationKey('key', id)),
      ];
      if (keys.length === 0) return false;
      try {
        const values = await Promise.all(keys.map((k) => redis.get(k)));
        return values.some((v) => v !== null && v !== undefined);
      } catch (err) {
        // Fail-open, like getCurrentVersion: a one-credential revocation is the
        // same class of signal as a tokenVersion bump, and a Redis outage must
        // not lock every session out. Counted so it is alertable.
        emitCounter('token_revocation_fail_open_total', { reason: 'credential-read-error' });
        logger.debug('Credential-revocation read failed (fail-open)', { error: errorMessage(err) });
        return false;
      }
    },
  };
}

/**
 * Build a {@link TokenRevocationStore} backed by a Redis client that is lazily
 * constructed from the standard `REDIS_URL` or `REDIS_SENTINELS` env —
 * for a stateless service that keeps NO Redis client of its own. The client is
 * built on first `getCurrentVersion` call and memoized; `ioredis` is loaded via
 * a guarded dynamic require so merely importing this never breaks a build/test
 * where Redis isn't present.
 *
 * FULLY FAIL-OPEN: no env configured, an ioredis load failure, a connect error,
 * or any read failure all resolve to `null` ("no known revocation"), so a
 * service degrades to natural token expiry rather than locking users out. A
 * service opts in with a single boot line:
 *   `setTokenRevocationStore(createEnvRedisTokenRevocationStore());`
 */
export function createEnvRedisTokenRevocationStore(): TokenRevocationStore {
  type ReaderRedis = RedisCacheClient & ReadyAwareRedis;
  // undefined = not yet attempted; null = attempted and unavailable (stay off).
  let cached: ReaderRedis | null | undefined;
  let ready: (() => Promise<void>) | undefined;

  /**
   * The reader client, built on first use. The env client has no offline queue,
   * so a GET before the first connection completes is rejected — which made the
   * FIRST impersonation check on every pod read 'unavailable' (401). Wait
   * (bounded, never rejecting) for readiness; a genuinely down Redis then keeps
   * the existing fail-open / 'unavailable' semantics.
   */
  async function client(): Promise<ReaderRedis | null> {
    if (cached === undefined) {
      // Shared env-configured ioredis construction (error listener attached, null
      // when Redis isn't configured); the reader stays fail-open — a null client
      // just falls back to natural token expiry.
      cached = createEnvRedisClient<ReaderRedis>('revocation-reader');
      if (cached) {
        logger.info('Redis token-revocation reader initialized');
        ready = createRedisReadyGate(cached);
      }
    }
    if (ready) await ready();
    return cached;
  }

  return {
    async getCurrentVersion(userId: string): Promise<number | null> {
      const redis = await client();
      if (!redis) return null;
      return createRedisTokenRevocationStore(redis).getCurrentVersion(userId);
    },
    async getSessionRevocation(jti: string): Promise<SessionRevocationState> {
      const redis = await client();
      // No Redis configured ⇒ there is no way to learn a session was ended, so
      // an impersonation token can't be trusted. Every real deployment runs Redis
      // (the build queue needs it), so this only bites a misconfigured service.
      if (!redis) {
        emitCounter('session_revocation_unavailable_total', { reason: 'not-configured' });
        return 'unavailable';
      }
      return createRedisTokenRevocationStore(redis).getSessionRevocation!(jti);
    },
    async isCredentialRevoked(refs: CredentialRevocationRefs): Promise<boolean> {
      const redis = await client();
      if (!redis) return false;
      return createRedisTokenRevocationStore(redis).isCredentialRevoked!(refs);
    },
  };
}

/**
 * Publish a user's current `tokenVersion` so the stateless services see the
 * revocation immediately (platform side). Best-effort — never throws; a failure
 * just means the services fall back to natural token expiry for this change.
 *
 * The write is an atomic set-if-greater ({@link SET_IF_GREATER_LUA}), so an
 * out-of-order publish can never lower the stored version.
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
    // Atomic set-if-greater: concurrent publishes can arrive out of order, and a
    // plain SET would let the older version win. A client that can't run Lua is
    // refused (caught below) rather than written racily.
    if (typeof redis.eval !== 'function') throw new Error('Redis client cannot run scripts (eval unavailable)');
    await redis.eval(SET_IF_GREATER_LUA, 1, tokenRevocationKey(userId), String(tokenVersion), Math.max(1, Math.floor(ttlSeconds)));
  } catch (err) {
    logger.warn('Token-revocation publish failed (services fall back to token expiry)', {
      userId, error: errorMessage(err),
    });
  }
}

/**
 * Publish that one IMPERSONATION session has ended, so every stateless service
 * rejects its token on the next request (platform side).
 *
 * Returns whether the publish landed — unlike `publishTokenRevocation`, which is
 * fire-and-forget. The caller must be able to tell the person who ended the
 * session that it did NOT end everywhere, rather than reporting success while
 * the token still works against other services.
 *
 * The entry expires with the session: once the token itself can no longer be
 * used, there is nothing left to revoke, so the key cleans itself up.
 *
 * @param ttlMs - time remaining on the session's token
 */
export async function publishSessionRevocation(
  redis: RedisCacheClient,
  jti: string,
  ttlMs: number,
): Promise<boolean> {
  try {
    await redis.set(sessionRevocationKey(jti), '1', 'PX', Math.max(1000, Math.ceil(ttlMs)));
    return true;
  } catch (err) {
    logger.warn('Session-revocation publish failed (other services will honour the token until it expires)', {
      error: errorMessage(err),
    });
    return false;
  }
}

/**
 * Publish that ONE credential — a session slot (`sid`) or an access key
 * (`key`) — has been revoked, so every service rejects the tokens that name it
 * on the next request (platform side).
 *
 * `ttlSeconds` MUST be at least the longest lifetime of any token that can
 * carry this id (an access token minted from the slot, an exchanged key token,
 * or a token derived from one): the entry lapsing first would read as "not
 * revoked" while such a token is still alive.
 *
 * Returns whether the publish landed, so the caller can report a revocation
 * that did not reach the other services instead of claiming success.
 */
export async function publishCredentialRevocation(
  redis: RedisCacheClient,
  kind: CredentialKind,
  id: string,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    await redis.set(credentialRevocationKey(kind, id), '1', 'EX', Math.max(1, Math.ceil(ttlSeconds)));
    return true;
  } catch (err) {
    logger.warn('Credential-revocation publish failed (services honour the credential until its tokens expire)', {
      kind, error: errorMessage(err),
    });
    return false;
  }
}
