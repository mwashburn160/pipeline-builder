// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { INTERNAL_SERVICES, isSystemAdmin, normalizeOrgId, requireInternalService, requirePermission, requireSystemAdmin as requireSystemAdminGate, userHasPermission, sendError, ErrorCode, getParam, createLogger, recordAuthzDenial, tagRouteGate } from '@pipeline-builder/api-core';
import type { Permission } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';

const logger = createLogger('authorize-org');

interface AuthorizeOrgOptions {
  /**
   * If true, only system admins (the `isSuperAdmin` token claim) may access.
   * If false (default), same-org members OR system admins may access.
   */
  requireSystemAdmin?: boolean;
  /**
   * Require this permission instead of the superadmin FLAG — for a cross-tenant
   * route that should be staffable with a Role.
   *
   * It replaces `requireSystemAdmin` rather than adding to it: a superadmin
   * holds every permission implicitly, so the flag still passes. The param
   * canonicalization above still runs either way, which is why this is an option
   * here instead of a middleware swapped in at the route — dropping it made
   * `findOrgWithHierarchy` resolve a mixed-case `:orgId` to "no such org".
   */
  permission?: Permission;
}

/**
 * Create middleware that checks the requesting user has access to
 * the target organization identified by `:orgId` in the route params.
 *
 * Must be used after `requireAuth`.
 *
 * @example
 * ```typescript
 * // Same-org or system admin
 * router.get('/:orgId', requireAuth(authOpts), authorizeOrg(), handler);
 *
 * // System admin only
 * router.put('/:orgId', requireAuth(authOpts), authorizeOrg({ requireSystemAdmin: true }), handler);
 * ```
 */
export function authorizeOrg(options: AuthorizeOrgOptions = {}) {
  const { requireSystemAdmin = false, permission } = options;
  const permissionGate = permission ? requirePermission(permission) : undefined;

  // Tagged for the route table: the `requireSystemAdmin: true` variant IS the
  // route's authorization gate (it delegates to api-core's `requireSystemAdmin`
  // below), so the coverage test must see it. The default variant is a tenancy
  // check, not a capability gate, and carries no tag.
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, 401, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }

    const requestingOrgId = req.user.organizationId;
    if (!requestingOrgId) {
      return sendError(res, 400, 'Organization ID is required. Please provide x-org-id header.', ErrorCode.MISSING_REQUIRED_FIELD);
    }

    const rawTargetOrgId = getParam(req.params, 'orgId');
    const targetOrgId = normalizeOrgId(rawTargetOrgId);
    if (!targetOrgId) {
      return sendError(res, 400, 'Organization ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    }
    // Canonicalize the param for everything downstream. The service compares org
    // ids as STRINGS in several places — `findOrgWithHierarchy` matches
    // `String(_id)` (always lowercase hex) and `{ parentOrgId: orgId }` against
    // stored lowercase strings — so a mixed-case `:orgId` silently resolved to
    // "no such org / no hierarchy" while this guard happily admitted it.
    req.params.orgId = targetOrgId;

    // A cross-tenant route that names a permission delegates to api-core's
    // permission gate, for the same reason the flag variant delegates below: the
    // denial goes through the shared `authz.denied` auditor.
    if (permissionGate) {
      return permissionGate(req, res, next);
    }

    // System-admin-only routes delegate to api-core's gate so a denial is
    // routed through the shared `authz.denied` auditor (wired at boot by
    // wireServiceSecurity) instead of a silent hand-rolled 403.
    if (requireSystemAdmin) {
      if (!isSystemAdmin(req)) logger.warn('Access denied — system admin required', { requestingOrgId, targetOrgId });
      return requireSystemAdminGate(req, res, next);
    }

    // Case-insensitive to tolerate client casing variations (e.g., `ORG-1`
    // vs `org-1`). Org-creation normalizes case at storage time, so two
    // orgs cannot coexist with same-name-different-case — the lower() on
    // both sides is convenience, not a security weakening. See test
    // `should allow same-org access case-insensitively`.
    //
    // Both sides go through api-core's `normalizeOrgId`, the SINGLE spelling
    // rule (`getIdentity` and platform's `controller-helper` use the same one),
    // so a mixed-case org id is judged identically at every hop instead of
    // passing here and 403'ing on platform.
    const callerOrg = normalizeOrgId(requestingOrgId);
    const isSameOrg = callerOrg !== undefined && callerOrg === targetOrgId;

    // Standard routes — same-org, a platform operator, or a system admin.
    //
    // `platform:read` is here so the operator quota views actually work for a
    // Role instead of only for the flag: `/quotas/all` and `/quotas/at-risk` are
    // gated on it, and drilling into one of those rows reads
    // `GET /quotas/:orgId`. Without this the fleet list rendered and every row
    // 403'd. It is system-org-only, so no tenant Role can reach another tenant
    // through it.
    if (!isSameOrg && !isSystemAdmin(req) && !userHasPermission(req, 'platform:read')) {
      logger.warn('Access denied — cross-org without admin', { requestingOrgId, targetOrgId });
      recordAuthzDenial(req, 'same-org, platform:read or system-admin');
      return sendError(
        res, 403,
        'Access denied. You can only access quotas for your own organization.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    next();
  }, ...(permission
    ? [{ kind: 'permission', mode: 'any', permissions: [permission] } as const]
    : requireSystemAdmin ? [{ kind: 'systemAdmin' } as const] : []));
}

/**
 * Gate the internal usage-counter endpoints (`POST /quotas/:orgId/increment`
 * and `/decrement`) to internal service callers. `authorizeOrg()` alone
 * admits any same-org member, which would let a member inflate or roll back
 * their own counters and defeat the caps — and a system admin is no more
 * entitled to move a tenant's usage counters than a member is, so that path is
 * gone too: an internal route refuses every user token.
 *
 * The caller list is the whole internal fleet because EVERY service meters its
 * own inbound traffic through api-core's quota client (`SERVICE_NAME` names the
 * signer). It is still a closed list of cryptographically-named identities: the
 * same list `deploy/*​/k8s/istio-internal-routes.yaml` names, enforced here so it
 * also holds in docker compose, which runs no mesh.
 *
 * Use after `requireAuth` + `authorizeOrg()`.
 */
export const requireInternalCaller = requireInternalService({ callers: INTERNAL_SERVICES });
