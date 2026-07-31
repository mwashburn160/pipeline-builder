// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';
import { isSystemAdmin, userHasPermission } from '../middleware/auth.js';
import { ErrorCode } from '../types/error-codes.js';
import type { Permission } from '../types/permissions.js';
import { AccessModifier } from '../types/pipeline.js';
import { sendError } from '../utils/response.js';

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
  publishPermission?: Permission,
): boolean {
  // Private resources: no extra gate (org-scoping already applies). Public/non-private:
  // a system admin OR the holder of the matching publish permission may modify it — so
  // the same permission that let a non-superadmin PUBLISH it (create path) also lets
  // them manage it. The write itself stays pinned to the caller's org, so this never
  // grants cross-org reach. Without a publishPermission, it stays superadmin-only.
  const mayModify = isSystemAdmin(req) || (!!publishPermission && userHasPermission(req, publishPermission));
  if (!mayModify && resource.accessModifier !== AccessModifier.PRIVATE) {
    sendError(
      res,
      403,
      'You lack permission to modify this public resource.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
    return false;
  }
  return true;
}
