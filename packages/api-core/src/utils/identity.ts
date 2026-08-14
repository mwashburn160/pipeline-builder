// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getHeaderString } from './headers.js';
import type { HttpRequest } from '../types/http.js';

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
 * app.post('/api/resource', requireAuth, async (req, res) => {
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
  // Prefer JWT-verified claims (req.user) over raw headers to prevent
  // spoofing. Headers are only used as fallback or for fields not in the
  // JWT (e.g. requestId). The JWT payload uses `sub` for the user id per
  // OIDC convention; that's our authoritative source.
  const user = req.user;
  // Canonical orgId normalization — the SINGLE source of truth. Lowercasing
  // (and trimming) ONCE here guarantees the RLS GUC (`identityScope` reads this
  // raw `identity.orgId`) and the app-layer WHERE clauses (route-wrapper /
  // app-factory, which historically re-lowercased) always agree on tenant. A
  // mismatch — GUC set to `Acme` while WHERE queries `acme` — would, under
  // owner-bypass RLS, silently scope reads to the wrong (or no) tenant. Empty /
  // whitespace-only collapses to undefined so "missing org" stays falsy.
  const rawOrgId = user?.organizationId || getHeaderString(req.headers['x-org-id']);
  const orgId = rawOrgId?.trim().toLowerCase() || undefined;
  return {
    orgId,
    userId: user?.sub || getHeaderString(req.headers['x-user-id']),
    requestId: getHeaderString(req.headers['x-request-id']),
    role: user?.role || getHeaderString(req.headers['x-user-role']),
  };
}
