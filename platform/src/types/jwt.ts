// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Access token payload structure.
 * Contains user identity and permissions for API authorization.
 */
export interface AccessTokenPayload {
  /** Token type discriminator */
  type: 'access';
  /** User ID (MongoDB ObjectId as string) */
  sub: string;
  /** Username */
  username: string;
  /** User email address */
  email: string;
  /** Per-org role in the active organization */
  role: 'owner' | 'admin' | 'member';
  /** Whether user has admin privileges (owner or admin) */
  isAdmin: boolean;
  /** Organization's quota tier */
  tier?: string;
  /** Resolved feature flags for this user/org */
  features?: string[];
  /** Active organization ID */
  organizationId?: string;
  /** Organization name */
  organizationName?: string;
  /** Whether user's email is verified */
  isEmailVerified: boolean;
  /** Token version for session invalidation */
  tokenVersion: number;
  /** JWT ID (unique identifier) */
  jti?: string;
  /** Issued at timestamp */
  iat?: number;
  /** Expiration timestamp */
  exp?: number;
}

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
 * User role type.
 * - 'user': Standard user with limited permissions
 * - 'admin': Organization administrator with full permissions
 */
export type UserRole = 'owner' | 'admin' | 'member';
