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

export interface RefreshTokenPayload {
  sub: string;
  tokenVersion: number;
  iat?: number;
  exp?: number;
}