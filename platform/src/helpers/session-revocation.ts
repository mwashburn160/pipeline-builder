// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-revocation PUBLISHER (platform side).
 *
 * Platform's own `requireAuth` validates a token's `tokenVersion` against Mongo,
 * but the STATELESS services (plugin/compliance/…) can't read Mongo. api-core
 * therefore exposes a Redis-backed revocation channel (key `authrev:tv:<userId>`):
 * the services READ it via `createRedisTokenRevocationStore`, and platform WRITES
 * a user's CURRENT `tokenVersion` here on every privilege change so those services
 * reject tokens minted before the change immediately — not at natural expiry.
 *
 * Every helper is BEST-EFFORT: it never throws. A Redis outage (or no Redis
 * configured at all) simply means the services fall back to token expiry, which
 * the short access-token TTL keeps small.
 *
 * Ordering: call these AFTER the transaction/commit that bumped `tokenVersion` —
 * they re-read the now-current value, so publishing post-commit is correct (and
 * idempotent under nested bumps: the final version always wins).
 */

import { createLogger, errorMessage, publishTokenRevocation } from '@pipeline-builder/api-core';
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
 * Effective revocation-entry TTL (seconds). Must be >= the LONGEST possible
 * access-token lifetime so an entry can never lapse while a token that predates
 * it is still alive (a lapsed entry reads as "no known revocation" — fail-open —
 * which would let a revoked-but-unexpired token through). We take the max of the
 * configured ceiling, the base JWT TTL, and every per-tier override.
 *
 * `config` is imported LAZILY so this file's static graph stays free of the
 * prod-env-requiring config module (it's transitively imported by many
 * unit-tested services); this only runs on the live publish path.
 */
async function revocationTtlSeconds(): Promise<number> {
  const { config } = await import('../config/index.js');
  const tierOverrides = Object.values(config.auth.jwt.tierExpiresIn)
    .filter((v): v is number => typeof v === 'number');
  return Math.max(
    config.auth.sessionRevocationTtlSeconds,
    config.auth.jwt.expiresIn,
    ...tierOverrides,
  );
}

/**
 * Publish a single user's CURRENT `tokenVersion` so the stateless services see
 * the revocation immediately. Best-effort — swallows every error.
 */
export async function publishUserRevocation(userId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!redis) return; // no Redis configured — services fall back to token expiry

    const User = await getUserModel();
    const user = await User.findById(userId).select('+tokenVersion').lean();
    if (!user || typeof user.tokenVersion !== 'number') return;

    await publishTokenRevocation(redis, String(userId), user.tokenVersion, await revocationTtlSeconds());
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
          ? publishTokenRevocation(redis, String(u._id), u.tokenVersion, ttl)
          : Promise.resolve(),
      ),
    );
  } catch (err) {
    logger.warn('publishUsersRevocation failed (best-effort; falling back to token expiry)', {
      count: userIds?.length, error: errorMessage(err),
    });
  }
}
