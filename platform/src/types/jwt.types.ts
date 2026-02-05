/**
 * @module types/jwt
 * @description JWT token payload type definitions.
 */

/**
 * Access token payload structure.
 * Contains user identity and permissions for API authorization.
 */
export interface AccessTokenPayload {
  /** User ID (MongoDB ObjectId as string) */
  sub: string;
  /** Username */
  username: string;
  /** User email address */
  email: string;
  /** User role */
  role: 'user' | 'admin';
  /** Whether user has admin privileges */
  isAdmin: boolean;
  /** Organization ID the user belongs to */
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
export type UserRole = 'user' | 'admin';
