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
 * Canonical org-id normalization: trim + lowercase, empty ⇒ undefined.
 *
 * The SINGLE spelling rule for a tenant id across the fleet. Org ids are
 * 24-hex ObjectId strings (plus the `'system'` sentinel), and hex is
 * case-insensitive — so `Acme`-style casing differences resolve to the SAME
 * Mongo document while string comparisons (`activeOrgId === targetOrgId`, an
 * RLS GUC vs a WHERE clause, a cache key) silently disagree. Everything that
 * compares or keys on an org id normalizes through here so the comparison and
 * the lookup can never drift apart.
 */
export function normalizeOrgId(orgId: string | undefined | null): string | undefined {
  return orgId?.trim().toLowerCase() || undefined;
}

/**
 * The actor id written when nothing in the request attributes the action to a
 * person — an internal service hop, a scheduler tick, a token whose subject
 * never resolved. One spelling, because the audit trail is queried by it.
 */
export const SYSTEM_ACTOR_ID = 'system';

/**
 * The actor id written for an UNAUTHENTICATED actor: an anonymous public plugin
 * submission (docs/plans/plugin-ecosystem.md §4, §5c — the event carries
 * `details.submissionId` for correlation and is recorded against the system
 * org; the submitter's email, hashed or otherwise, never appears in the audit
 * trail) and platform's pre-auth `device.authorize.start` (a device-login code
 * requested before anyone has signed in). Distinct from {@link SYSTEM_ACTOR_ID}, which means "no person
 * involved", not "a person we don't know".
 */
export const ANONYMOUS_ACTOR_ID = 'anonymous';

/**
 * The actor id to stamp on an audit event, from a route context.
 *
 * Route handlers used to reach back into `req.user.sub` themselves, with
 * fallbacks that disagreed across services (`?? ''`, `?? userId ?? 'system'`,
 * `?? 'system'`) — so the same unattributable write landed in the trail under
 * three different actors depending on which route wrote it.
 *
 * `rc.userId` is already the normalized identity `withRoute` resolved (JWT
 * `sub`, else the `x-user-id` hop header — see {@link getIdentity}), so this is
 * the same value the rest of the request is scoped by, and the ONE place the
 * "unattributable" sentinel is chosen. Accepts anything carrying a `userId`,
 * which the route context does — pass `rc`, or `{ userId }` when the handler
 * destructures.
 */
export function actorId(rc: { userId?: string | null }): string {
  return rc.userId || SYSTEM_ACTOR_ID;
}

/**
 * Extract identity information from request headers.
 *
 * Extracts common identity headers used for multi-tenant authentication:
 * - x-org-id: Organization identifier (INTERNAL SERVICE hops only, see below)
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
  // The `x-org-id` header is CLIENT-SETTABLE, so it is only ever honored for a
  // principal that has no tenant of its own to speak for:
  //   - an INTERNAL SERVICE principal (`principalType: 'service'`), whose token
  //     names the signing service rather than the tenant it is acting for —
  //     that is the S2S hop convention (the cascade, the quota client, …); and
  //   - a request with no verified principal at all (`attachRequestContext`
  //     runs before `requireAuth`, which recomputes this from the JWT).
  // For a USER or SERVICE-ACCOUNT principal the JWT is the ONLY authority.
  // Platform can mint a user token with no `organizationId` (a person between
  // orgs, mid-invite, mid-onboarding), and the old `user?.organizationId ||
  // header` fallback let such a token name any tenant it liked — a value that
  // flows straight into the RLS tenant GUC. Absent ⇒ undefined ⇒ the route's
  // `requireOrgId` refuses the call, which is the correct answer.
  const principalType = user?.principalType;
  const headerOrgId = getHeaderString(req.headers['x-org-id']);
  const mayUseHeaderOrg = !user || principalType === 'service';
  const rawOrgId = user?.organizationId || (mayUseHeaderOrg ? headerOrgId : undefined);
  // Normalized ONCE here (see normalizeOrgId) so the RLS GUC (`identityScope`
  // reads this `identity.orgId`) and the app-layer WHERE clauses (route-wrapper
  // / app-factory, which historically re-lowercased) always agree on tenant. A
  // mismatch — GUC set to `Acme` while WHERE queries `acme` — would, under
  // owner-bypass RLS, silently scope reads to the wrong (or no) tenant.
  const orgId = normalizeOrgId(rawOrgId);
  return {
    orgId,
    userId: user?.sub || getHeaderString(req.headers['x-user-id']),
    requestId: getHeaderString(req.headers['x-request-id']),
    role: user?.role || getHeaderString(req.headers['x-user-role']),
  };
}
