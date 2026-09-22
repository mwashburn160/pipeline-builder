// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-revocation PUBLISHER (platform side).
 *
 * Platform's own `requireAuth` validates a token's `tokenVersion` claim against
 * Mongo, but the STATELESS services (plugin/compliance/…) can't read Mongo.
 * api-core therefore exposes a Redis-backed revocation channel (key
 * `authrev:tv:<userId>`): the services READ it via
 * `createRedisTokenRevocationStore`, and platform WRITES a user's CURRENT access
 * version (`tokenVersion` + `claimsVersion`, see helpers/access-version.ts) here
 * on every revocation or claims change so those services reject tokens minted
 * before it immediately — not at natural expiry.
 *
 * Single credentials are revoked through their own keys: `revoke:sid:<sid>` for
 * one session slot and `revoke:key:<keyId>` for one access key.
 *
 * Every helper is BEST-EFFORT: it never throws. A Redis outage (or no Redis
 * configured at all) simply means the services fall back to token expiry, which
 * the short access-token TTL keeps small.
 *
 * Ordering: call these AFTER the transaction/commit that bumped a version —
 * they publish the value the `$inc` returned (or re-read the now-current one);
 * the store's atomic set-if-greater means the highest version always wins.
 */

import {
  API_KEY_TOKEN_TTL_SECONDS,
  createLogger,
  errorMessage,
  publishCredentialRevocation,
  publishSessionRevocation,
  publishTokenRevocation,
} from '@pipeline-builder/api-core';
import { accessTokenVersion } from './access-version.js';
import { getRedisClient } from '../utils/redis-client.js';

const logger = createLogger('session-revocation');

/**
 * Lazily resolve the User model. Kept out of this file's STATIC import graph (as
 * `config` is) so that merely importing this helper — which every instrumented
 * service does transitively — never forces a real model / config / mongoose load.
 * That keeps the helper linkable under every suite's mock strategy. Only the live
 * publish path (Redis configured) ever reaches this.
 */
async function getUserModel() {
  return (await import('../models/user.js')).default;
}

/**
 * Effective revocation-entry TTL (seconds). Must be >= the LONGEST access-token
 * lifetime platform can issue, so an entry can never lapse while a token that
 * predates it is still alive (a lapsed entry reads as "no known revocation" —
 * fail-open — which would let a revoked-but-unexpired token through).
 *
 * Every issuable access token is bounded by one of these: a session token
 * (interactive AND machine — a machine credential's access tokens are capped at
 * the per-tier lifetime, see `accessTokenTtlSeconds` in utils/token.ts), an
 * exchanged access-key token, or an impersonation token. We take the max of
 * those and the configured floor.
 *
 * `config` is imported LAZILY so this file's static graph stays free of the
 * prod-env-requiring config module (it's transitively imported by many
 * unit-tested services); this only runs on the live publish path.
 */
export async function revocationTtlSeconds(): Promise<number> {
  const { config } = await import('../config/index.js');
  const { IMPERSONATION_SESSION_TTL_MS } = await import('../constants/impersonation.js');
  const tierOverrides = Object.values(config.auth.jwt.tierExpiresIn)
    .filter((v): v is number => typeof v === 'number');
  return Math.max(
    config.auth.sessionRevocationTtlSeconds,
    config.auth.jwt.expiresIn,
    ...tierOverrides,
    API_KEY_TOKEN_TTL_SECONDS,
    Math.ceil(IMPERSONATION_SESSION_TTL_MS / 1000),
  );
}

/**
 * Publish a single user's CURRENT access-token version so the stateless services see
 * the revocation immediately. Best-effort — swallows every error.
 *
 * `accessVersion` — the value the caller's atomic `$inc` RETURNED (the
 * post-update document). Pass it whenever the bump site has it: it is exactly
 * the version this change produced, whereas a re-read could observe a stale
 * replica and publish an older value that the store's set-if-greater then
 * silently ignores. Without it the current value is re-read (primary).
 */
export async function publishUserRevocation(userId: string, accessVersion?: number): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!redis) return; // no Redis configured — services fall back to token expiry

    if (typeof accessVersion === 'number') {
      await publishTokenRevocation(redis, String(userId), accessVersion, await revocationTtlSeconds());
      return;
    }

    const User = await getUserModel();
    const user = await User.findById(userId).select('+tokenVersion').lean();
    if (!user || typeof user.tokenVersion !== 'number') return;

    await publishTokenRevocation(redis, String(userId), accessTokenVersion(user), await revocationTtlSeconds());
  } catch (err) {
    logger.warn('publishUserRevocation failed (best-effort; falling back to token expiry)', {
      userId, error: errorMessage(err),
    });
  }
}

/**
 * Batch variant for bulk bumps (e.g. an org tier change that `updateMany`s every
 * member). Reads all current versions in ONE query, then publishes each. Best-
 * effort — swallows every error.
 */
export async function publishUsersRevocation(userIds: Array<string | { toString(): string }>): Promise<void> {
  try {
    if (!userIds || userIds.length === 0) return;
    const redis = await getRedisClient();
    if (!redis) return;

    const ids = userIds.map((id) => String(id));
    const ttl = await revocationTtlSeconds();
    const User = await getUserModel();
    const users = await User.find({ _id: { $in: ids } }).select('+tokenVersion').lean();

    await Promise.all(
      users.map((u) =>
        typeof u.tokenVersion === 'number'
          ? publishTokenRevocation(redis, String(u._id), accessTokenVersion(u), ttl)
          : Promise.resolve(),
      ),
    );
  } catch (err) {
    logger.warn('publishUsersRevocation failed (best-effort; falling back to token expiry)', {
      count: userIds?.length, error: errorMessage(err),
    });
  }
}

/**
 * Publish a revocation for a user being DELETED. Unlike {@link publishUserRevocation},
 * this takes the tokenVersion explicitly because the user doc is (about to be)
 * gone and can't be read back. Publishing `tokenVersion + 1` makes the stateless
 * services reject EVERY outstanding token for the user (each minted at version
 * <= the captured tokenVersion) immediately, rather than letting a deleted
 * user's token keep working on plugin/compliance until natural expiry (~15 min).
 * Platform's own `requireAuth` already rejects the missing user; this closes the
 * stateless-service gap. Best-effort — swallows every error.
 */
export async function publishUserDeletionRevocation(userId: string, accessVersion: number): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!redis) return; // no Redis configured — services fall back to token expiry
    await publishTokenRevocation(redis, String(userId), accessVersion + 1, await revocationTtlSeconds());
  } catch (err) {
    logger.warn('publishUserDeletionRevocation failed (best-effort; falling back to token expiry)', {
      userId, error: errorMessage(err),
    });
  }
}

/**
 * Publish that one impersonation session ended, so every OTHER service rejects
 * its token on the next request. The platform itself already refuses it — its
 * auth middleware reads the session record directly — so this is what makes
 * ending a session true everywhere, not just here.
 *
 * Returns whether that is now true. The caller reports it to whoever ended the
 * session, rather than saying "session ended" while the token still works
 * against other services.
 *
 * @param jti        - the session's token id
 * @param consumedAt - when the session's token was issued
 */
export async function publishImpersonationSessionRevocation(jti: string, consumedAt: Date | undefined): Promise<boolean> {
  const { IMPERSONATION_SESSION_TTL_MS } = await import('../constants/impersonation.js');
  const issuedAt = consumedAt ? new Date(consumedAt).getTime() : Date.now();
  const remainingMs = issuedAt + IMPERSONATION_SESSION_TTL_MS - Date.now();
  // The token has already expired everywhere: nothing is left to revoke.
  if (remainingMs <= 0) return true;

  try {
    const redis = await getRedisClient();
    if (!redis) {
      logger.warn('No Redis configured — impersonation session ended on the platform only', { jti });
      return false;
    }
    return await publishSessionRevocation(redis, jti, remainingMs);
  } catch (err) {
    logger.warn('Impersonation session revocation publish failed', { jti, error: errorMessage(err) });
    return false;
  }
}

/**
 * Publish that ONE refresh-session slot was revoked (a signed-out device, a
 * stopped machine credential, a slot killed by refresh-token reuse), so every
 * other service rejects the access tokens minted for it (`revoke:sid:<sid>`,
 * checked in api-core's `requireAuth`). Platform itself checks the slot in
 * Mongo. Best-effort — never throws; returns whether the publish landed.
 */
export async function publishSessionSlotRevocation(sessionIds: string | readonly string[]): Promise<boolean> {
  const ids = (typeof sessionIds === 'string' ? [sessionIds] : [...sessionIds]).filter(Boolean);
  if (ids.length === 0) return true;
  try {
    const redis = await getRedisClient();
    if (!redis) return false;
    const ttl = await revocationTtlSeconds();
    const results = await Promise.all(ids.map((sid) => publishCredentialRevocation(redis, 'sid', sid, ttl)));
    return results.every(Boolean);
  } catch (err) {
    logger.warn('publishSessionSlotRevocation failed (best-effort; falling back to token expiry)', { error: errorMessage(err) });
    return false;
  }
}

/**
 * Publish that an ACCESS KEY (PAT or service-account key) was revoked, so every
 * service rejects the tokens exchanged from it (`jti` = key id) and every token
 * derived from one (`parentKeyId`) — `revoke:key:<keyId>`. Best-effort — never
 * throws; returns whether the publish landed.
 */
export async function publishAccessKeyRevocation(keyIds: string | readonly string[]): Promise<boolean> {
  const ids = (typeof keyIds === 'string' ? [keyIds] : [...keyIds]).filter(Boolean);
  if (ids.length === 0) return true;
  try {
    const redis = await getRedisClient();
    if (!redis) return false;
    const ttl = await revocationTtlSeconds();
    const results = await Promise.all(ids.map((id) => publishCredentialRevocation(redis, 'key', id, ttl)));
    return results.every(Boolean);
  } catch (err) {
    logger.warn('publishAccessKeyRevocation failed (best-effort; falling back to token expiry)', { error: errorMessage(err) });
    return false;
  }
}
