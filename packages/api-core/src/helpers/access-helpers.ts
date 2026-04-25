// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';
import { isSystemAdmin } from '../middleware/auth';
import { ErrorCode } from '../types/error-codes';
import { AccessModifier } from '../types/pipeline';
import { sendError } from '../utils/response';

/**
 * Apply access control to a read-filter.
 *
 * Pass-through: forwards the caller's filter unchanged. Multi-tenant access
 * scoping is handled in the query builder (`AccessControlQueryBuilder`),
 * which combines the caller's `orgId` with `accessModifier` to return:
 * caller's org rows + system-org public rows by default.
 *
 * Kept as a stable wrapper so route handlers retain a single, named hook
 * for future per-route policy adjustments.
 */
export function applyAccessControl<T extends { accessModifier?: string }>(
  filter: T,
  _req: Request,
): T {
  return filter;
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
  if (!isSystemAdmin(req) && resource.accessModifier !== AccessModifier.PRIVATE) {
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
