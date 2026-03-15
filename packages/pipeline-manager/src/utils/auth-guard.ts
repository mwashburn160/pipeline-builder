import { printError } from './output-utils';

/**
 * Decoded JWT token payload (subset of fields relevant for authorization).
 */
interface TokenPayload {
  role?: string;
  isAdmin?: boolean;
  sub?: string;
  organizationId?: string;
}

/**
 * Decode a JWT token payload without verification.
 *
 * The token signature is NOT verified here — the server validates it
 * on every API call. This is used only for local role checks in the CLI.
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
 * Require that the current user has an admin role.
 *
 * Decodes the PLATFORM_TOKEN JWT and checks for `role === 'admin'`.
 * Prints an error and throws if the check fails.
 *
 * @param token - JWT bearer token from PLATFORM_TOKEN
 * @throws Error if the user is not an admin
 */
export function requireAdmin(token: string): void {
  const payload = decodeTokenPayload(token);

  if (!payload) {
    printError('Unable to decode authentication token');
    throw new Error('Invalid authentication token');
  }

  if (payload.role !== 'admin') {
    printError('Access denied. This command requires system admin or admin role.');
    throw new Error('Insufficient permissions: admin role required');
  }
}
