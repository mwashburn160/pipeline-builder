// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, requirePublicAccess, sendBadRequest, sendSuccess, sendEntityNotFound, normalizeArrayFields } from '@pipeline-builder/api-core';
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
 * restore un-does a destructive action).
 */
export function createRestorePipelineRoutes(): Router {
  const router: Router = Router();

  router.post('/:id/restore', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Pipeline restore request received', { id });

    // Load the TOMBSTONE (isActive=false + deletedAt set) — a live pipeline or an
    // unknown id yields null → 404 (nothing to restore).
    const existing = await pipelineService.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Pipeline');

    // Only system admins / publish-holders can restore a non-private (public)
    // pipeline — same gate as delete.
    if (!requirePublicAccess(req, res, existing, 'pipelines:publish')) return;

    const restored = await pipelineService.restore(id, orgId, userId || 'system');
    if (!restored) return sendEntityNotFound(res, 'Pipeline');

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
