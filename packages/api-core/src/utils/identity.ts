/**
 * @module utils/identity
 * @description Identity extraction utilities for multi-tenant applications.
 */

import { getHeaderString } from './headers';
import { HttpRequest } from '../types/http';

/**
 * Identity information extracted from request headers.
 */
export interface RequestIdentity {
  /** Organization ID from x-org-id header */
  readonly orgId?: string;
  /** User ID from x-user-id header */
  readonly userId?: string;
  /** Request ID from x-request-id header */
  readonly requestId?: string;
  /** User role from x-user-role header (decoded from JWT) */
  readonly role?: string;
}

/**
 * Extract identity information from request headers.
 *
 * Extracts common identity headers used for multi-tenant authentication:
 * - x-org-id: Organization identifier
 * - x-user-id: User identifier
 * - x-request-id: Request trace identifier
 * - x-user-role: User role
 *
 * @param req - HTTP request object
 * @returns Identity object with orgId, userId, requestId, and role
 *
 * @example
 * ```typescript
 * app.post('/api/resource', authenticateToken, async (req, res) => {
 *   const identity = getIdentity(req);
 *
 *   if (!identity.orgId) {
 *     return sendError(res, 400, 'x-org-id header required');
 *   }
 *
 *   // Use identity.orgId, identity.userId, etc.
 * });
 * ```
 */
export function getIdentity(req: HttpRequest): RequestIdentity {
  // Prefer JWT-verified claims (req.user) over raw headers to prevent spoofing.
  // Headers are only used as fallback or for fields not in the JWT (e.g. requestId).
  const user = req.user;
  return {
    orgId: user?.organizationId || getHeaderString(req.headers['x-org-id']),
    userId: user?.userId || getHeaderString(req.headers['x-user-id']),
    requestId: getHeaderString(req.headers['x-request-id']),
    role: user?.role || getHeaderString(req.headers['x-user-role']),
  };
}

/**
 * Validate that required identity fields are present.
 *
 * @param identity - Identity object to validate
 * @param required - Array of required field names
 * @returns Object with isValid boolean and missing fields array
 *
 * @example
 * ```typescript
 * const identity = getIdentity(req);
 * const validation = validateIdentity(identity, ['orgId', 'userId']);
 *
 * if (!validation.isValid) {
 *   return sendError(res, 400, `Missing required headers: ${validation.missing.join(', ')}`);
 * }
 * ```
 */
export function validateIdentity(
  identity: RequestIdentity,
  required: (keyof RequestIdentity)[],
): { isValid: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const field of required) {
    if (!identity[field]) {
      missing.push(`x-${field.replace(/([A-Z])/g, '-$1').toLowerCase()}`);
    }
  }

  return {
    isValid: missing.length === 0,
    missing,
  };
}
