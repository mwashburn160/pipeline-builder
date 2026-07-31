// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, requirePublicAccess, sendBadRequest, sendSuccess, sendEntityNotFound } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { emitPipelineAudit } from '../services/audit.js';
import { pipelineService } from '../services/pipeline-service.js';

/**
 * Register the DELETE route on a router.
 *
 * Expects `requireAuth` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createDeletePipelineRoutes(): Router {
  const router: Router = Router();

  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Pipeline delete request received', { id });

    const existing = await pipelineService.findById(id, orgId);

    if (!existing) return sendEntityNotFound(res, 'Pipeline');

    // System admins or publish-permission holders can delete non-private (public) pipelines
    if (!requirePublicAccess(req, res, existing, 'pipelines:publish')) return;

    // The delete write is pinned to the caller's org, so a public/system-org
    // sample the read surfaced matches zero rows → returns falsy. Don't report a
    // 200 or emit a `pipeline.delete` audit for a deletion that never happened.
    const deleted = await pipelineService.delete(id, orgId, userId || 'system');
    if (!deleted) return sendEntityNotFound(res, 'Pipeline');

    ctx.log('COMPLETED', 'Deleted pipeline', { id, name: existing.pipelineName });

    // Best-effort attributed audit — emitted only after the delete landed.
    emitPipelineAudit({
      action: 'pipeline.delete',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      targetType: 'pipeline',
      targetId: id,
      details: {
        pipelineName: existing.pipelineName,
        accessModifier: existing.accessModifier,
      },
    });

    return sendSuccess(res, 200, undefined, 'Pipeline deleted.');
  }));

  return router;
}
