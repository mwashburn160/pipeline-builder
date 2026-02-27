/**
 * @module routes/delete-pipeline
 * @description Pipeline deletion.
 *
 * DELETE /pipelines/:id — delete a pipeline by its UUID
 *
 * Permissions:
 *   - System admins: can delete public and private pipelines
 *   - Org admins: can delete private pipelines only
 *   - Regular users: can delete private pipelines only
 */

import { getParam, ErrorCode, isSystemAdmin, errorMessage, sendBadRequest, sendError, sendInternalError, sendSuccess } from '@mwashburn160/api-core';
import { getContext } from '@mwashburn160/api-server';
import { Router, Request, Response } from 'express';
import { sendPipelineNotFound } from '../helpers/pipeline-helpers';
import { pipelineService } from '../services/pipeline-service';

/**
 * Register the DELETE route on a router.
 *
 * Expects `authenticateToken` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createDeletePipelineRoutes(): Router {
  const router: Router = Router();

  router.delete('/:id', async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const orgId = ctx.identity.orgId?.toLowerCase();
    if (!orgId) return sendBadRequest(res, 'Organization ID is required');

    ctx.log('INFO', 'Pipeline delete request received', { id });

    try {
      const existing = await pipelineService.findById(id, orgId);

      if (!existing) return sendPipelineNotFound(res);

      // Only system admins can delete non-private (public) pipelines
      if (!isSystemAdmin(req) && existing.accessModifier !== 'private') {
        ctx.log('INFO', 'Non-system-admin denied deletion of non-private pipeline', {
          id, accessModifier: existing.accessModifier,
        });
        return sendError(res, 403, 'Only system admins can delete public pipelines.', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }

      await pipelineService.delete(id, orgId, ctx.identity.userId || 'system');

      ctx.log('COMPLETED', 'Deleted pipeline', { id, name: existing.pipelineName });

      return sendSuccess(res, 200, undefined, 'Pipeline deleted.');
    } catch (error) {
      ctx.log('ERROR', 'Failed to delete pipeline', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
