// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, loadAndRestore, sendSuccess, actorId, recordAudit } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { pluginService } from '../services/plugin-service.js';

/**
 * Register the RESTORE route — undo a soft-delete within the retention window
 * (before the purge sweep hard-deletes the tombstone).
 *
 * Expects auth + orgId, `requirePermission('plugins:write')` and `requireStepUp`
 * from the parent mount (index.ts), whose single step-up layer it shares with
 * purge (delete's authority plus a step-up re-verify, since restore reverses a
 * destructive act).
 * The load → publish-gate → restore → 404 skeleton is shared via `loadAndRestore`.
 */
export function createRestorePluginRoutes(): Router {
  const router: Router = Router();

  router.post('/:id/restore', audited('plugin.restore'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const result = await loadAndRestore(req, res, pluginService, { orgId, userId, label: 'Plugin', publishPermission: 'plugins:publish' });
    if (!result) return;
    const { existing, restored } = result;

    ctx.log('COMPLETED', 'Restored plugin', { id: restored.id, name: restored.name });

    recordAudit({
      action: 'plugin.restore',
      actorId: actorId({ userId }),
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'plugin',
      targetId: restored.id,
      details: {
        pluginName: restored.name,
        version: restored.version,
        visibility: restored.visibility,
      },
    });

    return sendSuccess(res, 200, { plugin: shapePlugin(restored) }, 'Plugin restored.');
  }));

  return router;
}
