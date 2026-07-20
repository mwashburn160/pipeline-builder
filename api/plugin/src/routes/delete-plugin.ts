// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, requirePublicAccess, sendBadRequest, sendSuccess, sendEntityNotFound } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { emitPluginAudit } from '../services/audit.js';
import { pluginService } from '../services/plugin-service.js';

/**
 * Register the DELETE route on a router.
 *
 * Expects `requireAuth` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createDeletePluginRoutes(): Router {
  const router: Router = Router();

  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Plugin delete request received', { id });

    const existing = await pluginService.findById(id, orgId);

    if (!existing) return sendEntityNotFound(res, 'Plugin');

    // Only system admins can delete non-private (public) plugins
    if (!requirePublicAccess(req, res, existing)) return;

    await pluginService.delete(id, orgId, userId || 'system');

    ctx.log('COMPLETED', 'Deleted plugin', { id, name: existing.name });

    // Best-effort attributed audit — emitted only after the delete landed.
    emitPluginAudit({
      action: 'plugin.delete',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      targetType: 'plugin',
      targetId: id,
      details: {
        pluginName: existing.name,
        version: existing.version,
        accessModifier: existing.accessModifier,
      },
    });

    return sendSuccess(res, 200, undefined, 'Plugin deleted.');
  }));

  return router;
}
