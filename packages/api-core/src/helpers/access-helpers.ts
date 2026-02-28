/**
 * @module helpers/access-helpers
 * @description Access control helpers for route handlers.
 *
 * Provides reusable functions for applying access control to query filters
 * and checking resource-level permissions.
 */

import type { Request, Response } from 'express';
import { isSystemAdmin } from '../middleware/auth';
import { ErrorCode } from '../types/error-codes';
import { sendError } from '../utils/response';

/**
 * Apply access control to a filter object.
 *
 * Non-system-admins are restricted to 'private' (org-scoped) resources.
 * System admins see all access modifiers.
 *
 * @param filter - Query filter to modify
 * @param req - Express request (used to check admin status)
 * @returns Filter with accessModifier applied for non-admins
 *
 * @example
 * ```typescript
 * const effectiveFilter = applyAccessControl(filter, req);
 * const results = await service.find(effectiveFilter, orgId);
 * ```
 */
export function applyAccessControl<T extends { accessModifier?: string }>(
  filter: T,
  req: Request,
): T {
  return !isSystemAdmin(req)
    ? { ...filter, accessModifier: 'private' as const }
    : filter;
}

/**
 * Check whether a non-admin user may modify a public resource.
 *
 * Returns `true` if the request may proceed. Returns `false` and sends
 * a 403 response if the user lacks permission.
 *
 * @param req - Express request
 * @param res - Express response
 * @param resource - Resource with an accessModifier field
 * @returns `true` if access is allowed, `false` if blocked (response already sent)
 *
 * @example
 * ```typescript
 * if (!requirePublicAccess(req, res, pipeline)) return;
 * await pipelineService.delete(id, orgId, userId);
 * ```
 */
export function requirePublicAccess(
  req: Request,
  res: Response,
  resource: { accessModifier?: string },
): boolean {
  if (!isSystemAdmin(req) && resource.accessModifier !== 'private') {
    sendError(
      res,
      403,
      'Only system admins can modify public resources.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
    return false;
  }
  return true;
}
