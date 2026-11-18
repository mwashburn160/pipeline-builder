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
 * OPERATOR revocation reaches the impersonation sessions the user OPENED, too:
 * every user-version publish below also ends (Mongo `revoked` + the per-session
 * `authrev:jti:<jti>` key) each live session whose operator stamp no longer
 * matches the operator — see {@link endOperatorImpersonationSessions}. That is
 * keyed by the session's `jti`, NOT the impersonated subject's id, so the subject
 * stays signed in to their own sessions.
 *
 * That sweep is INDEPENDENT of the Redis publish: it runs whether the user-version
 * publish landed, failed, or had no Redis to go to (and whether the re-read found
 * the user), because its Mongo half — the `revoked` flip and the
 * `admin.impersonate.revoke` audit — is the record of the session ending and
 * must not depend on a cache. Only its per-session `jti` publish is best-effort.
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
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { accessTokenVersion } from './access-version.js';
import { isImpersonationOperatorStale, type ImpersonationOperatorState } from './impersonation-operator.js';
import { getRedisClient } from '../utils/redis-client.js';

const logger = createLogger('session-revocation');

/**
 * Lazily resolve the User model. Kept out of this file's STATIC import graph (as
 * `config` is) so that merely importing this helper — which every instrumented
 * service does transitively — never forces a real model / config / mongoose load.
 * That keeps the helper linkable under every suite's mock strategy. Only the live
 * publish path and the operator-session sweep (which first checks Mongo is
 * connected — see {@link endOperatorImpersonationSessions}) ever reach this.
 */
async function getUserModel() {
  return (await import('../models/user.js')).default;
}

/** Lazily resolve the ImpersonationRequest model — same reason as {@link getUserModel}. */
async function getImpersonationRequestModel() {
  return (await import('../models/impersonation-request.js')).default;
}

/**
 * Effective revocation-entry TTL (seconds). Must be >= the LONGEST access-token
 * lifetime platform can issue, so an entry can never lapse while a token that
 * predates it is still alive (a lapsed entry reads as "no known revocation" —
 * fail-open — which would let a revoked-but-unexpired token through).
 *
 * Every issuable access token is bounded by one of these: a session token
 * (interactive AND machine — a machine credential's access tokens are capped at
 * the per-tier lifetime, see `accessTokenTtlSeconds` in services/session/access-tokens.ts), an
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
    await publishUserVersion(userId, accessVersion);
  } catch (err) {
    logger.warn('publishUserRevocation failed (best-effort; falling back to token expiry)', {
      userId, error: errorMessage(err),
    });
  }
  // Whatever the publish did — see the file header.
  await sweepOperatorSessions([String(userId)]);
}

/** The Redis half of {@link publishUserRevocation}. Throws; the caller swallows. */
async function publishUserVersion(userId: string, accessVersion?: number): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) return; // no Redis configured — services fall back to token expiry

  if (typeof accessVersion === 'number') {
    await publishTokenRevocation(redis, String(userId), accessVersion, await revocationTtlSeconds());
    return;
  }
  const User = await getUserModel();
  const user = await User.findById(userId).select('tokenVersion claimsVersion').lean();
  if (!user || typeof user.tokenVersion !== 'number') return;
  await publishTokenRevocation(redis, String(userId), accessTokenVersion(user), await revocationTtlSeconds());
}

/**
 * Run {@link endOperatorImpersonationSessions} for the publishers: never throws
 * (a sweep failure is logged; the platform's per-request operator check still
 * refuses a stale session), and never couples to the Redis outcome.
 */
async function sweepOperatorSessions(operatorIds: readonly string[], opts: { operatorGone?: boolean } = {}): Promise<void> {
  try {
    await endOperatorImpersonationSessions(operatorIds, opts);
  } catch (err) {
    logger.warn('Ending a revoked operator\'s impersonation sessions failed (the platform still refuses them per request)', {
      count: operatorIds.length, error: errorMessage(err),
    });
  }
}

/**
 * Batch variant for bulk bumps (e.g. an org tier change that `updateMany`s every
 * member). Reads all current versions in ONE query, then publishes each. Best-
 * effort — swallows every error.
 */
export async function publishUsersRevocation(userIds: Array<string | { toString(): string }>): Promise<void> {
  if (!userIds || userIds.length === 0) return;
  const ids = userIds.map((id) => String(id));
  try {
    const redis = await getRedisClient();
    if (redis) {
      const ttl = await revocationTtlSeconds();
      const User = await getUserModel();
      const users = await User.find({ _id: { $in: ids } }).select('tokenVersion claimsVersion').lean();

      await Promise.all(
        users.map((u) =>
          typeof u.tokenVersion === 'number'
            ? publishTokenRevocation(redis, String(u._id), accessTokenVersion(u), ttl)
            : Promise.resolve(),
        ),
      );
    }
  } catch (err) {
    logger.warn('publishUsersRevocation failed (best-effort; falling back to token expiry)', {
      count: ids.length, error: errorMessage(err),
    });
  }
  // Whatever the publish did — see the file header.
  await sweepOperatorSessions(ids);
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
    // No Redis configured — services fall back to token expiry.
    if (redis) await publishTokenRevocation(redis, String(userId), accessVersion + 1, await revocationTtlSeconds());
  } catch (err) {
    logger.warn('publishUserDeletionRevocation failed (best-effort; falling back to token expiry)', {
      userId, error: errorMessage(err),
    });
  }
  // The operator is gone, so every session they opened ends unconditionally —
  // whatever the publish did.
  await sweepOperatorSessions([String(userId)], { operatorGone: true });
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
 * End every LIVE impersonation session OPENED BY one of `operatorIds` that its
 * operator's current state no longer supports, everywhere — not just on the
 * platform (whose auth middleware already refuses it per request via the same
 * rule, {@link isImpersonationOperatorStale}).
 *
 * The stateless services check an impersonation token's revocation by its
 * `jti` (`authrev:jti:<jti>`), and its `sub` is the IMPERSONATED user — so
 * bumping/publishing the subject's version would sign the subject out of their
 * own account. Instead each stale session is:
 *   1. flipped `consumed` → `revoked` in Mongo (guarded, so a concurrent end by
 *      a person or another publish wins once), and
 *   2. published by `jti` (`publishImpersonationSessionRevocation`), and
 *   3. audited as `admin.impersonate.revoke` by the SYSTEM actor (nobody in a
 *      request ended it) with reason `operator-revoked`.
 *
 * A session is "stale" when the operator's hard `tokenVersion` moved, they
 * lost the superadmin flag a superadmin session was opened on, or — for a
 * tenant-authority (ancestor-admin) session — their `claimsVersion` moved.
 * Sessions the operator still supports are left alone, so an unrelated publish
 * (e.g. a superadmin's claims change) never ends them. `operatorGone` (the
 * operator was deleted) ends them all without reading the operator.
 *
 * Called from the user-version publishers, i.e. every tokenVersion /
 * claimsVersion bump site, after commit — ALWAYS, not only when their Redis
 * publish landed. THROWS on a DB error — the callers' best-effort wrappers log
 * and swallow it; the platform's own per-request check still refuses the session
 * either way.
 *
 * NO-HANG GUARD. Returns 0 without querying when the model's Mongo connection
 * is not open. The bump sites run under hundreds of unit suites with no Mongo at
 * all, and a query on an unconnected mongoose model doesn't fail — it BUFFERS
 * (until `bufferTimeoutMS`), stalling the suite. (This used to be implied by
 * running only after a live Redis publish, which unit suites never have.) In a
 * running platform Mongo is connected; a sweep skipped during a reconnect is
 * covered by the per-request check.
 */
export async function endOperatorImpersonationSessions(
  operatorIds: readonly string[],
  opts: { operatorGone?: boolean } = {},
): Promise<number> {
  if (operatorIds.length === 0) return 0;
  const ImpersonationRequest = await getImpersonationRequestModel();
  if (ImpersonationRequest.db?.readyState !== 1) {
    logger.debug('Mongo not connected — operator impersonation-session sweep skipped', { count: operatorIds.length });
    return 0;
  }
  const now = new Date();
  const live = await ImpersonationRequest.find({
    requesterId: { $in: [...operatorIds] },
    status: 'consumed',
    expiresAt: { $gt: now },
  })
    .select('_id jti consumedAt requesterId targetUserId organizationId requesterTokenVersion requesterClaimsVersion requesterSuperAdmin')
    .lean();
  if (live.length === 0) return 0;

  const operators = new Map<string, ImpersonationOperatorState>();
  if (!opts.operatorGone) {
    const User = await getUserModel();
    const requesterIds = [...new Set(live.map((s) => String(s.requesterId)))];
    const rows = await User.find({ _id: { $in: requesterIds } }).select('+isSuperAdmin').lean();
    for (const u of rows) operators.set(String(u._id), u);
  }

  const stale = live.filter((s) => isImpersonationOperatorStale(s, operators.get(String(s.requesterId))));
  if (stale.length === 0) return 0;

  const { recordAuditEvent } = await import('./audit.js');
  let ended = 0;
  for (const s of stale) {
    const res = await ImpersonationRequest.updateOne(
      { _id: s._id, status: 'consumed' },
      { $set: { status: 'revoked', revokedAt: now } },
    );
    // Someone else ended it first — they published and audited it.
    if ((res.modifiedCount ?? 0) === 0) continue;
    ended++;
    const revokedEverywhere = s.jti ? await publishImpersonationSessionRevocation(s.jti, s.consumedAt) : true;
    recordAuditEvent({
      action: 'admin.impersonate.revoke',
      actorId: SYSTEM_ACTOR_ID,
      orgId: SYSTEM_ORG_ID,
      ...(s.organizationId ? { affectedOrgId: String(s.organizationId) } : {}),
      targetType: 'user',
      targetId: String(s.targetUserId),
      outcome: 'success',
      details: {
        impersonationRequestId: String(s._id),
        requesterId: String(s.requesterId),
        reason: 'operator-revoked',
        revokedEverywhere,
      },
    });
  }
  if (ended > 0) logger.info('Ended impersonation sessions of a revoked operator', { ended });
  return ended;
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
