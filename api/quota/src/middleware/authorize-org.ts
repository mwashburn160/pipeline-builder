/**
 * @module middleware/authorize-org
 * @description Org-scoped authorization guard.
 *
 * Must be used after `authenticateToken`.
 *
 * Access rules:
 *  - Same-org users can always access their own org's routes.
 *  - Cross-org access requires system admin (role=admin + org=system).
 *  - Routes with `requireSystemAdmin: true` reject same-org non-admins entirely.
 */

import { isSystemAdmin, sendError, ErrorCode, getParam, createLogger } from '@mwashburn160/api-core';
import { Request, Response, NextFunction } from 'express';
import { sendMissingOrgId } from '../helpers/quota-helpers';

const logger = createLogger('authorize-org');

export interface AuthorizeOrgOptions {
  /**
   * If true, only system admins (role=admin in the system org) may access.
   * If false (default), same-org members OR system admins may access.
   */
  requireSystemAdmin?: boolean;
}

/**
 * Create middleware that checks the requesting user has access to
 * the target organization identified by `:orgId` in the route params.
 *
 * Must be used after `authenticateToken`.
 *
 * @example
 * ```typescript
 * // Same-org or system admin
 * router.get('/:orgId', authenticateToken(authOpts), authorizeOrg(), handler);
 *
 * // System admin only
 * router.put('/:orgId', authenticateToken(authOpts), authorizeOrg({ requireSystemAdmin: true }), handler);
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
      return sendMissingOrgId(res);
    }

    const targetOrgId = getParam(req.params, 'orgId');
    if (!targetOrgId) {
      return sendError(res, 400, 'Organization ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    }

    const isSameOrg = requestingOrgId.toLowerCase() === targetOrgId.toLowerCase();
    const isSysAdmin = isSystemAdmin(req);

    // System-admin-only routes — reject everyone else
    if (requireSystemAdmin && !isSysAdmin) {
      logger.warn('Access denied — system admin required', { requestingOrgId, targetOrgId });
      return sendError(
        res, 403,
        'Access denied. Only system administrators can perform this action.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    // Standard routes — same-org or system admin
    if (!requireSystemAdmin && !isSameOrg && !isSysAdmin) {
      logger.warn('Access denied — cross-org without admin', { requestingOrgId, targetOrgId });
      return sendError(
        res, 403,
        'Access denied. You can only access quotas for your own organization.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    next();
  };
}
