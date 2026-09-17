// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sign/verify options for platform-issued JWTs (access, PAT, impersonation,
 * step-up).
 *
 * Platform MINTS the tokens every other service verifies with api-core's
 * `requireAuth`, so the two must agree exactly: the pinned algorithm, the
 * optional `JWT_ISSUER` / `JWT_AUDIENCE`, and rotation via `JWT_SECRET_PREVIOUS`.
 * These mirror api-core's `buildJwtVerifyOptions` / `verifyJwtWithRotation`
 * (reading platform's validated config instead of raw env);
 * test/jwt-options-parity.test.ts verifies platform tokens with the real
 * api-core functions so the two can't drift.
 */

import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/** Options for `jwt.sign` with the platform access-token secret. */
export function jwtSignOptions(expiresIn: number): jwt.SignOptions {
  const { algorithm, issuer, audience } = config.auth.jwt;
  return {
    algorithm,
    expiresIn,
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  };
}

/** Options for `jwt.verify`: pinned algorithm plus issuer/audience when configured. */
export function jwtVerifyOptions(): jwt.VerifyOptions {
  const { algorithm, issuer, audience } = config.auth.jwt;
  return {
    algorithms: [algorithm],
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  };
}

/**
 * Verify against the current secret, falling back to `JWT_SECRET_PREVIOUS` only
 * for a signature failure — never for an expired or not-yet-valid token, whose
 * error is authoritative whichever secret signed it.
 */
export function verifyPlatformJwt<T>(token: string): T {
  const options = jwtVerifyOptions();
  try {
    return jwt.verify(token, config.auth.jwt.secret, options) as T;
  } catch (err) {
    const previous = config.auth.jwt.secretPrevious;
    if (
      previous
      && err instanceof jwt.JsonWebTokenError
      && !(err instanceof jwt.TokenExpiredError)
      && !(err instanceof jwt.NotBeforeError)
    ) {
      return jwt.verify(token, previous, options) as T;
    }
    throw err;
  }
}
