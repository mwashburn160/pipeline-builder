// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { loadAndRestore, sendSuccess, normalizeArrayFields } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { emitPipelineAudit } from '../services/audit.js';
import { pipelineService } from '../services/pipeline-service.js';

/**
 * Register the RESTORE route on a router — undo a soft-delete within the
 * retention window (before the purge sweep hard-deletes the tombstone).
 *
 * Expects `requireAuth`, `requireOrgId`, `requirePermission('pipelines:write')`
 * and `requireStepUp` to have been applied as router-level middleware in the
 * parent (mirrors the delete route's authority, plus a step-up re-verify since
 * restore un-does a destructive action). The load → publish-gate → restore → 404
 * skeleton is shared via `loadAndRestore`.
 */
export function createRestorePipelineRoutes(): Router {
  const router: Router = Router();

  router.post('/:id/restore', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const result = await loadAndRestore(req, res, orgId, userId || 'system', pipelineService, 'Pipeline', 'pipelines:publish');
    if (!result) return;
    const { existing, restored } = result;

    ctx.log('COMPLETED', 'Restored pipeline', { id: restored.id, name: restored.pipelineName });

    // Best-effort attributed audit — `affectedOrgId` records the target's org so
    // a no-org sysadmin restore is attributed to the org whose row changed.
    emitPipelineAudit({
      action: 'pipeline.restore',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'pipeline',
      targetId: restored.id,
      details: {
        pipelineName: restored.pipelineName,
        accessModifier: restored.accessModifier,
      },
    });

    return sendSuccess(res, 200, { pipeline: normalizeArrayFields(restored, ['keywords']) }, 'Pipeline restored.');
  }));

  return router;
}
