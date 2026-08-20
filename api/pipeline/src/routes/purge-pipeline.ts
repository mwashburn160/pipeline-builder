// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { loadAndPurge, sendSuccess } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { emitPipelineAudit } from '../services/audit.js';
import { pipelineService } from '../services/pipeline-service.js';

/**
 * Register the PURGE route on a router — permanently hard-delete a soft-deleted
 * pipeline tombstone on demand (the manual counterpart to the retention sweep,
 * which would remove it later once `purge_after` passes).
 *
 * Expects `requireAuth`, `requireOrgId`, `requirePermission('pipelines:write')`
 * and `requireStepUp` to have been applied as router-level middleware in the
 * parent (mirrors the restore authority — delete's write-gate plus a step-up
 * re-verify, since purge is a permanent destructive action). This router shares
 * the restore router's single step-up-gated mount so the single-use step-up jti
 * is consumed exactly once per request (see src/index.ts). The load →
 * publish-gate → hard-delete → 404 skeleton is shared via `loadAndPurge`, which
 * loads only a genuine tombstone (a live row 404s and is never hard-deleted).
 */
export function createPurgePipelineRoutes(): Router {
  const router: Router = Router();

  router.post('/:id/purge', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const result = await loadAndPurge(req, res, orgId, pipelineService, 'Pipeline', 'pipelines:publish');
    if (!result) return;
    const { existing, purgedId } = result;

    ctx.log('COMPLETED', 'Purged pipeline', { id: purgedId, name: existing.pipelineName });

    // Best-effort attributed audit — `affectedOrgId` records the target's org so
    // a no-org sysadmin purge is attributed to the org whose row was removed.
    emitPipelineAudit({
      action: 'pipeline.purge',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'pipeline',
      targetId: purgedId,
      details: {
        pipelineName: existing.pipelineName,
        accessModifier: existing.accessModifier,
      },
    });

    return sendSuccess(res, 200, {}, 'Pipeline permanently deleted.');
  }));

  return router;
}
