// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemAdmin, requireSystemAdmin as requireSystemAdminGate, sendError, ErrorCode, getParam, createLogger, recordAuthzDenial } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';

const logger = createLogger('authorize-org');

interface AuthorizeOrgOptions {
  /**
   * If true, only system admins (the `isSuperAdmin` token claim) may access.
   * If false (default), same-org members OR system admins may access.
   */
  requireSystemAdmin?: boolean;
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
  const { requireSystemAdmin = false } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, 401, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }

    const requestingOrgId = req.user.organizationId;
    if (!requestingOrgId) {
      return sendError(res, 400, 'Organization ID is required. Please provide x-org-id header.', ErrorCode.MISSING_REQUIRED_FIELD);
    }

    const targetOrgId = getParam(req.params, 'orgId');
    if (!targetOrgId) {
      return sendError(res, 400, 'Organization ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);
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
    const isSameOrg = requestingOrgId.toLowerCase() === targetOrgId.toLowerCase();

    // Standard routes — same-org or system admin
    if (!isSameOrg && !isSystemAdmin(req)) {
      logger.warn('Access denied — cross-org without admin', { requestingOrgId, targetOrgId });
      recordAuthzDenial(req, 'same-org or system-admin');
      return sendError(
        res, 403,
        'Access denied. You can only access quotas for your own organization.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    next();
  };
}
