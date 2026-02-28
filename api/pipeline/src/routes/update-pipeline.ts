/**
 * @module routes/update-pipeline
 * @description Pipeline update.
 *
 * PUT /pipelines/:id — update a pipeline by its UUID
 */

import { getParam, ErrorCode, requirePublicAccess, resolveAccessModifier, sendBadRequest, sendSuccess, validateBody, PipelineUpdateSchema, pickDefined } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import {
  normalizePipeline,
  sendPipelineNotFound,
} from '../helpers/pipeline-helpers';
import { pipelineService } from '../services/pipeline-service';

/**
 * Register the UPDATE route on a router.
 *
 * Expects `requireAuth` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createUpdatePipelineRoutes(): Router {
  const router: Router = Router();

  router.put('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod
    const validation = validateBody(req, PipelineUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    ctx.log('INFO', 'Pipeline update request received', { id });

    const existing = await pipelineService.findById(id, orgId);

    if (!existing) return sendPipelineNotFound(res);

    // Only system admins can edit non-private pipelines
    if (!requirePublicAccess(req, res, existing)) return;

    // Build update data from validated body
    const updateData: Record<string, unknown> = {
      ...pickDefined({
        pipelineName: body.pipelineName,
        description: body.description,
        keywords: body.keywords,
        props: body.props, // Validated by PipelineUpdateSchema (BuilderPropsSchema)
        isActive: body.isActive,
        isDefault: body.isDefault,
      }),
      // Access modifier requires special handling (admin-only public)
      ...(body.accessModifier !== undefined ? { accessModifier: resolveAccessModifier(req, body.accessModifier) } : {}),
      updatedAt: new Date(),
      updatedBy: userId || 'system',
    };

    const updated = await pipelineService.update(
      id,
      updateData,
      orgId,
      userId || 'system',
    );

    if (!updated) return sendPipelineNotFound(res);

    ctx.log('COMPLETED', 'Updated pipeline', { id: updated.id, name: updated.pipelineName });

    return sendSuccess(res, 200, { pipeline: normalizePipeline(updated) });
  }));

  return router;
}
