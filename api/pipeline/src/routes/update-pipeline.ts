/**
 * @module routes/update-pipeline
 * @description Pipeline update.
 *
 * PUT /pipelines/:id — update a pipeline by its UUID
 */

import { getParam, ErrorCode, isSystemAdmin, errorMessage, sendBadRequest, sendError, sendInternalError, validateBody, PipelineUpdateSchema } from '@mwashburn160/api-core';
import { createRequestContext, SSEManager } from '@mwashburn160/api-server';
import { BuilderProps } from '@mwashburn160/pipeline-core';
import { Router, Request, Response } from 'express';
import {
  normalizePipeline,
  sendPipelineNotFound,
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

    // Validate request body with Zod
    const validation = validateBody(req, PipelineUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    if (!ctx.identity.orgId) return sendBadRequest(res, 'Organization ID is required');
    const orgId = ctx.identity.orgId;

    ctx.log('INFO', 'Pipeline update request received', { id });

    try {
      const existing = await pipelineService.findById(id, orgId);

      if (!existing) return sendPipelineNotFound(res);

      // Only system admins can edit non-private pipelines
      if (!isSystemAdmin(req) && existing.accessModifier !== 'private') {
        ctx.log('INFO', 'Non-system-admin denied edit of non-private pipeline', {
          id, accessModifier: existing.accessModifier,
        });
        return sendError(res, 403, 'Only system admins can edit public pipelines.', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }

      // Build update data from validated body
      const updateData: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: ctx.identity.userId || 'system',
      };

      if (body.pipelineName !== undefined) updateData.pipelineName = body.pipelineName;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.keywords !== undefined) updateData.keywords = body.keywords;
      if (body.props !== undefined) updateData.props = body.props as unknown as BuilderProps;
      if (body.isActive !== undefined) updateData.isActive = body.isActive;
      if (body.isDefault !== undefined) updateData.isDefault = body.isDefault;

      // Handle access modifier (only system admins can set to public)
      if (body.accessModifier !== undefined) {
        let accessModifier = body.accessModifier === 'public' ? 'public' : 'private';
        if (!isSystemAdmin(req) && accessModifier === 'public') {
          accessModifier = 'private';
          ctx.log('INFO', 'Non-system-admin forced to private access');
        }
        updateData.accessModifier = accessModifier;
      }

      const updated = await pipelineService.update(
        id,
        updateData,
        orgId,
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
