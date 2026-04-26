// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

interface TokenPayload {
  role?: string;
  isAdmin?: boolean;
  sub?: string;
  organizationId?: string;
  /** Standard JWT expiry claim, in seconds since epoch. */
  exp?: number;
  /** Standard JWT issued-at claim, in seconds since epoch. */
  iat?: number;
}

/**
 * Decode a JWT token payload without signature verification.
 *
 * SECURITY: NO signature verification. The decoded payload MUST NOT be used
 * for authorization decisions — the server validates the token on every API
 * call. Use only for advisory UX hints.
 */
export function decodeTokenPayload(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload) as TokenPayload;
  } catch {
    return null;
  }
}
