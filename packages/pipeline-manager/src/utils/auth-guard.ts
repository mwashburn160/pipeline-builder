import { printWarning } from './output-utils';

/**
 * Decoded JWT token payload (subset of fields relevant for advisory checks).
 */
interface TokenPayload {
  role?: string;
  isAdmin?: boolean;
  sub?: string;
  organizationId?: string;
}

/**
 * Decode a JWT token payload without signature verification.
 *
 * SECURITY: This performs NO signature verification. The decoded payload
 * MUST NOT be used for authorization decisions — the server validates
 * the token on every API call. This is used only for advisory UX hints
 * (e.g., warning the user they may lack permissions before making a request).
 *
 * @param token - JWT bearer token
 * @returns Decoded payload or null if decoding fails
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

/**
 * Advisory admin check — warns the user if their token does not appear
 * to have an admin role. Does NOT block execution since the server
 * performs the authoritative check on every API call.
 *
 * @param token - JWT bearer token from PLATFORM_TOKEN
 */
export function warnIfNotAdmin(token: string): void {
  const payload = decodeTokenPayload(token);

  if (!payload) {
    printWarning('Unable to decode token — the server will validate permissions on the API call');
    return;
  }

  if (payload.role !== 'admin' && payload.role !== 'owner') {
    printWarning('Token does not appear to have admin role — the server may reject this request');
  }
}
