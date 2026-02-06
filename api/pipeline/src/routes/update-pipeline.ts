/**
 * @module routes/update-pipeline
 * @description Pipeline update.
 *
 * PUT /pipelines/:id — update a pipeline by its UUID
 */

import { getParam, ErrorCode, isSystemAdmin } from '@mwashburn160/api-core';
import { createRequestContext, SSEManager } from '@mwashburn160/api-server';
import { db, schema, buildPipelineConditions } from '@mwashburn160/pipeline-core';
import { and } from 'drizzle-orm';
import { Router, Request, Response } from 'express';
import {
  buildUpdateData,
  normalizePipeline,
  errorMessage,
  sendBadRequest,
  sendPipelineNotFound,
  sendInternalError,
  PipelineUpdateBody,
} from '../helpers/pipeline-helpers';

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
      const conditions = buildPipelineConditions({ id }, ctx.identity.orgId!);
      const [existing] = await db
        .select()
        .from(schema.pipeline)
        .where(and(...conditions));

      if (!existing) return sendPipelineNotFound(res);

      // Only system admins can edit non-private pipelines
      if (!isSystemAdmin(req) && existing.accessModifier !== 'private') {
        ctx.log('INFO', 'Non-system-admin denied edit of non-private pipeline', {
          id, accessModifier: existing.accessModifier,
        });
        return res.status(403).json({
          success: false,
          statusCode: 403,
          error: 'Only system admins can edit public pipelines.',
          code: ErrorCode.INSUFFICIENT_PERMISSIONS,
        });
      }

      const { data: updateData, error: validationError } = buildUpdateData(
        req.body as PipelineUpdateBody,
        ctx.identity.userId || 'system',
      );

      if (validationError) return sendBadRequest(res, validationError);

      const [updated] = await db
        .update(schema.pipeline)
        .set(updateData)
        .where(and(...conditions))
        .returning();

      ctx.log('COMPLETED', 'Updated pipeline', { id: updated.id, name: updated.pipelineName });

      return res.status(200).json({ success: true, statusCode: 200, pipeline: normalizePipeline(updated) });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
