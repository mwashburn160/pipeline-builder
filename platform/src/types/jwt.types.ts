/**
 * Access token payload structure
 */
export interface AccessTokenPayload {
  sub: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  isAdmin: boolean;
  organizationId?: string;
  isEmailVerified: boolean;
  tokenVersion: number;
  jti?: string;
  iat?: number;
  exp?: number;
}

/**
 * Refresh token payload structure
 */
export interface RefreshTokenPayload {
  sub: string;
  tokenVersion: number;
  iat?: number;
  exp?: number;
}

/**
 * User role type
 */
export type UserRole = 'user' | 'admin';
