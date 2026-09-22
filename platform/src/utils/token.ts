// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Verification of the platform's own user JWTs (access and refresh). */

import jwt from 'jsonwebtoken';
import { verifyPlatformJwt, verifyRefreshJwt } from './jwt-options.js';
import type { AccessTokenPayload, RefreshTokenPayload } from '../types/index.js';

/** Verify and decode a JWT access token. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return verifyPlatformJwt<AccessTokenPayload>(token);
}

/** Verify and decode a JWT refresh token. */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = verifyRefreshJwt<RefreshTokenPayload>(token);
  // Assert token type (mirrors requireAuth's `access` check and api-core's
  // step-up check): reject an access/step-up token presented on the refresh path.
  // Load-bearing now that all four classes share ONE signing key — the `type`
  // claim is the only thing separating them.
  if ((payload as { type?: unknown }).type !== 'refresh') {
    throw new jwt.JsonWebTokenError('Invalid token type for refresh');
  }
  return payload;
}
