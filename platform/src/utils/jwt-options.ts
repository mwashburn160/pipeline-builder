// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verification for the tokens platform CONSUMES.
 *
 * Two chains, exactly as in api-core's `requireAuth` — platform is just the one
 * service that also holds the private half of the user chain:
 *
 * - **User tokens** (access, refresh, step-up, exchanged access keys) — ES256,
 *   signed by `services/token-signing`, verified here against the in-memory
 *   public keys (no JWKS round-trip to itself). Rotation is by `kid`.
 * - **Internal service tokens** (`principalType: 'service'`) — ES256 signed by
 *   the CALLING service with its own key, verified against the per-service
 *   public bundle every service mounts.
 *
 * Both chains are ES256 now, so a token is routed by **who owns its `kid`**, not
 * by its algorithm — exactly as api-core's `verifyBearerToken` does it. A token
 * that rides the wrong chain is REFUSED either way, which is what makes "no
 * shared-secret token is accepted anywhere" true on platform too.
 * `test/jwt-options-parity.test.ts` verifies platform-minted tokens with the
 * real api-core functions so the two can't drift.
 */

import { decodeJwtHeader, isServiceKid, verifyServiceJwt } from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { verifyUserJwtSync } from '../services/token-signing/index.js';

/**
 * Verify any bearer token platform receives.
 *
 * A `kid` published in the per-service bundle → the SERVICE chain, verified with
 * that service's key and required to name it in `sub`. Anything else → the user
 * chain (and a token claiming `principalType: 'service'` is refused there: an
 * internal identity may not ride the user signing key).
 */
export function verifyPlatformJwt<T>(token: string): T {
  const header = decodeJwtHeader(token);
  if (!header?.alg) throw new jwt.JsonWebTokenError('Malformed token header');

  if (header.kid && isServiceKid(header.kid)) {
    const { issuer, audience } = config.auth.jwt;
    const claims = verifyServiceJwt<T>(token, { kid: header.kid, issuer, audience });
    if ((claims as { principalType?: string }).principalType !== 'service') {
      throw new jwt.JsonWebTokenError('A service signing key may only mint a service principal');
    }
    return claims;
  }

  const claims = verifyUserJwtSync<T>(token);
  if ((claims as { principalType?: string }).principalType === 'service') {
    throw new jwt.JsonWebTokenError('Service principals may not be signed with the user signing key');
  }
  return claims;
}

/**
 * Verify a refresh-token JWT. Same ES256 key and `kid` rotation as every other
 * user token — platform both mints and consumes these, but giving them their own
 * secret is exactly the special case that made `REFRESH_TOKEN_SECRET` an extra
 * thing to rotate. The caller still asserts `type: 'refresh'`.
 */
export function verifyRefreshJwt<T>(token: string): T {
  return verifyUserJwtSync<T>(token);
}
