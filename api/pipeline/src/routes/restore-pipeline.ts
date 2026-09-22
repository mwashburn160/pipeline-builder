// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { loadAndRestore, sendSuccess, normalizeArrayFields, audited, actorId, recordAudit } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
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

  router.post('/:id/restore', audited('pipeline.restore'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const result = await loadAndRestore(req, res, pipelineService, { orgId, userId, label: 'Pipeline', publishPermission: 'pipelines:publish' });
    if (!result) return;
    const { existing, restored } = result;

    ctx.log('COMPLETED', 'Restored pipeline', { id: restored.id, name: restored.pipelineName });

    // Best-effort attributed audit — `affectedOrgId` records the target's org so
    // a no-org sysadmin restore is attributed to the org whose row changed.
    recordAudit({
      action: 'pipeline.restore',
      actorId: actorId({ userId }),
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'pipeline',
      targetId: restored.id,
      details: {
        pipelineName: restored.pipelineName,
        visibility: restored.visibility,
      },
    });

    return sendSuccess(res, 200, { pipeline: normalizeArrayFields(restored, ['keywords']) }, 'Pipeline restored.');
  }));

  return router;
}
