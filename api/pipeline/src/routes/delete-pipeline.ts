// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, requirePublicAccess, sendBadRequest, sendSuccess, sendEntityNotFound } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { pipelineService } from '../services/pipeline-service';

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

    // Only system admins can delete non-private (public) pipelines
    if (!requirePublicAccess(req, res, existing)) return;

    await pipelineService.delete(id, orgId, userId || 'system');

    ctx.log('COMPLETED', 'Deleted pipeline', { id, name: existing.pipelineName });

    return sendSuccess(res, 200, undefined, 'Pipeline deleted.');
  }));

  return router;
}
