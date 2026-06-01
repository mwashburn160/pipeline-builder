// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { JwtPayload } from '@pipeline-builder/api-core';

/**
 * Re-export of the canonical `JwtPayload` from api-core so peer services and
 * this platform agree on the access-token shape. Kept as a named export for
 * back-compat with the previous in-repo `JwtPayload` reference.
 */
export type { JwtPayload };

/**
 * Platform-local extension of the api-core access-token payload.
 *
 * api-core's `JwtPayload` is the shared baseline (sub/username/email/role/
 * org/tier/impersonation fields). The platform additionally tracks:
 *   - `isEmailVerified`  surfaced on the dashboard and gated by some routes;
 *   - `tokenVersion`     for "invalidate all sessions" — bumped on the user
 *                        doc, compared against the token's value on every
 *                        request to revoke outstanding tokens;
 *   - `jti`              unique id; written into `User.issuedTokens[]` so
 *                        operators can list/revoke individual tokens.
 *
 * These fields are platform-specific (no other service issues access tokens),
 * so they live here rather than in api-core. The base type comes from
 * api-core so any future field added there shows up automatically.
 */
export type AccessTokenPayload = JwtPayload & {
  /** Whether user's email is verified. */
  isEmailVerified?: boolean;
  /** Token version for session invalidation. */
  tokenVersion?: number;
  /** JWT ID (unique identifier). */
  jti?: string;
};

/**
 * Refresh token payload structure.
 * Minimal payload for token refresh operations.
 */
export interface RefreshTokenPayload {
  /** Token type discriminator */
  type: 'refresh';
  /** User ID (MongoDB ObjectId as string) */
  sub: string;
  /** Token version for session invalidation */
  tokenVersion: number;
  /** Issued at timestamp */
  iat?: number;
  /** Expiration timestamp */
  exp?: number;
}

/**
 * User role within an organization.
 * - 'owner': created the org or had ownership transferred to them; cannot be deleted while owning.
 * - 'admin': can manage org members and resources but not transfer/delete the org itself.
 * - 'member': standard org member.
 */
export type UserRole = 'owner' | 'admin' | 'member';
