/**
 * @module routes/update-pipeline
 * @description Pipeline update.
 *
 * PUT /pipelines/:id — update a pipeline by its UUID
 */

import { getParam, ErrorCode, isSystemAdmin, resolveAccessModifier, errorMessage, sendBadRequest, sendError, sendInternalError, sendSuccess, validateBody, PipelineUpdateSchema, pickDefined } from '@mwashburn160/api-core';
import { getContext } from '@mwashburn160/api-server';
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
export function createUpdatePipelineRoutes(): Router {
  const router: Router = Router();

  router.put('/:id', async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod
    const validation = validateBody(req, PipelineUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    const orgId = ctx.identity.orgId?.toLowerCase();
    if (!orgId) return sendBadRequest(res, 'Organization ID is required');

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
        ...pickDefined({
          pipelineName: body.pipelineName,
          description: body.description,
          keywords: body.keywords,
          props: body.props as unknown as BuilderProps,
          isActive: body.isActive,
          isDefault: body.isDefault,
        }),
        // Access modifier requires special handling (admin-only public)
        ...(body.accessModifier !== undefined ? { accessModifier: resolveAccessModifier(req, body.accessModifier) } : {}),
        updatedAt: new Date(),
        updatedBy: ctx.identity.userId || 'system',
      };

      const updated = await pipelineService.update(
        id,
        updateData,
        orgId,
        ctx.identity.userId || 'system',
      );

      if (!updated) return sendPipelineNotFound(res);

      ctx.log('COMPLETED', 'Updated pipeline', { id: updated.id, name: updated.pipelineName });

      return sendSuccess(res, 200, { pipeline: normalizePipeline(updated) });
    } catch (error) {
      ctx.log('ERROR', 'Failed to update pipeline', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
