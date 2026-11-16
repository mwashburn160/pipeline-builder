// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which shared-store keys hold a caller's sign-in budget — so an operator can
 * clear them (`scripts/rate-limit-unlock.ts`) instead of deleting Redis keys by
 * hand and guessing the key format.
 *
 * The formats here MUST match what the limiters write: the store prefix is
 * `rl:platform:<bucket>:` (api-server `createSharedRateLimitStore`, via
 * `createLimiter`), and the key is what the bucket's `keyGenerator` returns.
 * `test/rate-limit-unlock.test.ts` pins both against the real generators.
 */

import { createHash } from 'crypto';
import { ipKeyGenerator } from 'express-rate-limit';

/** Buckets keyed on the client IP alone (`extractClientIp`). */
export const IP_KEYED_AUTH_BUCKETS = ['auth', 'auth-register', 'auth-discovery'] as const;

/** The anonymous bucket of the root `generalLimiter` (`rateLimitKey` → `ip:<addr>`). */
const GENERAL_BUCKET = 'general';

/** The per-account failed-sign-in bucket (`loginAccountKey` → `a:<sha256>`). */
const LOGIN_ACCOUNT_BUCKET = 'login-account';

/** One store key, and the bucket it belongs to (for the operator's report). */
export interface UnlockTarget {
  bucket: string;
  key: string;
}

/** The store key for `bucket` and the limiter's own key. */
function storeKey(bucket: string, limiterKey: string): string {
  return `rl:platform:${bucket}:${limiterKey}`;
}

/**
 * Every key that holds sign-in budget for this caller.
 *
 *  - `ip`: the client address as platform saw it (`req.ip` after `trust proxy`),
 *    normalized the way `extractClientIp` does (an IPv6 address to its /64).
 *    Clears the sign-in, sign-up and discovery buckets, plus the anonymous
 *    general bucket — a locked-out person is anonymous.
 *  - `identifier`: the email or username typed at sign-in. Clears the
 *    per-account failed-password bucket, normalized like `loginAccountKey`.
 */
export function unlockTargets(opts: { ip?: string; identifier?: string }): UnlockTarget[] {
  const targets: UnlockTarget[] = [];
  const ip = opts.ip?.trim();
  if (ip) {
    const ipKey = ipKeyGenerator(ip, 64);
    for (const bucket of IP_KEYED_AUTH_BUCKETS) targets.push({ bucket, key: storeKey(bucket, ipKey) });
    targets.push({ bucket: GENERAL_BUCKET, key: storeKey(GENERAL_BUCKET, `ip:${ipKey}`) });
  }
  const identifier = opts.identifier?.trim().toLowerCase();
  if (identifier) {
    const hashed = `a:${createHash('sha256').update(identifier).digest('hex')}`;
    targets.push({ bucket: LOGIN_ACCOUNT_BUCKET, key: storeKey(LOGIN_ACCOUNT_BUCKET, hashed) });
  }
  return targets;
}
