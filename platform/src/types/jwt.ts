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
  /**
   * Global super-admin flag (cross-org). When true, the user is treated as
   * a sysadmin by `isSystemAdmin()` regardless of which org they're scoped to.
   * The canonical path for granting sysadmin authority going forward —
   * supersedes membership in the well-known "system" org. Both paths are
   * honored during the rollout.
   */
  isSuperAdmin?: boolean;
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
  /**
   * Set when the access token was issued via the sysadmin impersonation
   * flow (POST /admin/impersonate/:userId). Carries the original
   * sysadmin's user id so audit events under impersonation can attribute
   * the action correctly. Absent on normal access tokens.
   */
  impersonatorId?: string;
  /**
   * When true, the impersonation token is read-only — the
   * `requireWriteAccess` middleware rejects any non-GET request. Lets
   * sysadmins safely "view as" a tenant without risk of a destructive
   * action being performed under their session.
   */
  impersonationReadOnly?: boolean;
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
 * User role within an organization.
 * - 'owner': created the org or had ownership transferred to them; cannot be deleted while owning.
 * - 'admin': can manage org members and resources but not transfer/delete the org itself.
 * - 'member': standard org member.
 */
export type UserRole = 'owner' | 'admin' | 'member';
