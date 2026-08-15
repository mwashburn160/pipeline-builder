// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, requirePublicAccess, sendBadRequest, sendSuccess, sendEntityNotFound } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { emitPluginAudit } from '../services/audit.js';
import { pluginService } from '../services/plugin-service.js';

/**
 * Register the RESTORE route — undo a soft-delete within the retention window
 * (before the purge sweep hard-deletes the tombstone).
 *
 * Expects `requireAuth`, `requireOrgId`, `requirePermission('plugins:write')`
 * and `requireStepUp` router-level middleware in the parent (mirrors delete's
 * authority plus a step-up re-verify since restore reverses a destructive act).
 */
export function createRestorePluginRoutes(): Router {
  const router: Router = Router();

  router.post('/:id/restore', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Plugin restore request received', { id });

    const existing = await pluginService.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Plugin');

    // Only system admins / publish-holders can restore a non-private plugin.
    if (!requirePublicAccess(req, res, existing, 'plugins:publish')) return;

    const restored = await pluginService.restore(id, orgId, userId || 'system');
    if (!restored) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Restored plugin', { id: restored.id, name: restored.name });

    emitPluginAudit({
      action: 'plugin.restore',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'plugin',
      targetId: restored.id,
      details: {
        pluginName: restored.name,
        version: restored.version,
        accessModifier: restored.accessModifier,
      },
    });

    return sendSuccess(res, 200, { plugin: shapePlugin(restored) }, 'Plugin restored.');
  }));

  return router;
}
