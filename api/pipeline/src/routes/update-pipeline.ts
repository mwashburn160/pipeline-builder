/**
 * @module routes/update-pipeline
 * @description Pipeline update.
 *
 * PUT /pipelines/:id — update a pipeline by its UUID
 */

import { getParam, ErrorCode, isSystemAdmin, errorMessage, sendBadRequest, sendError, sendInternalError } from '@mwashburn160/api-core';
import { createRequestContext, SSEManager } from '@mwashburn160/api-server';
import { Router, Request, Response } from 'express';
import {
  buildUpdateData,
  normalizePipeline,
  sendPipelineNotFound,
  PipelineUpdateBody,
} from '../helpers/pipeline-helpers';
import { pipelineService } from '../services/pipeline-service';

/**
 * Register the UPDATE route on a router.
 *
 * Expects `authenticateToken` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createUpdatePipelineRoutes(sseManager: SSEManager): Router {
  const router: Router = Router();

  router.put('/:id', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Pipeline update request received', { id });

    try {
      const existing = await pipelineService.findById(id, ctx.identity.orgId!);

      if (!existing) return sendPipelineNotFound(res);

      // Only system admins can edit non-private pipelines
      if (!isSystemAdmin(req) && existing.accessModifier !== 'private') {
        ctx.log('INFO', 'Non-system-admin denied edit of non-private pipeline', {
          id, accessModifier: existing.accessModifier,
        });
        return sendError(res, 403, 'Only system admins can edit public pipelines.', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }

      const { data: updateData, error: validationError } = buildUpdateData(
        req.body as PipelineUpdateBody,
        ctx.identity.userId || 'system',
      );

      if (validationError) return sendBadRequest(res, validationError);

      const updated = await pipelineService.update(
        id,
        updateData,
        ctx.identity.orgId!,
        ctx.identity.userId || 'system',
      );

      if (!updated) return sendPipelineNotFound(res);

      ctx.log('COMPLETED', 'Updated pipeline', { id: updated.id, name: updated.pipelineName });

      return res.status(200).json({ success: true, statusCode: 200, pipeline: normalizePipeline(updated) });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
