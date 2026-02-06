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

import { getParam, ErrorCode, isSystemAdmin } from '@mwashburn160/api-core';
import { createRequestContext, SSEManager } from '@mwashburn160/api-server';
import { db, schema, buildPipelineConditions } from '@mwashburn160/pipeline-core';
import { and } from 'drizzle-orm';
import { Router, Request, Response } from 'express';
import {
  errorMessage,
  sendBadRequest,
  sendPipelineNotFound,
  sendInternalError,
} from '../helpers/pipeline-helpers';

/**
 * Register the DELETE route on a router.
 *
 * Expects `authenticateToken` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createDeletePipelineRoutes(sseManager: SSEManager): Router {
  const router: Router = Router();

  router.delete('/:id', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Pipeline delete request received', { id });

    try {
      const conditions = buildPipelineConditions({ id }, ctx.identity.orgId!);
      const [existing] = await db
        .select()
        .from(schema.pipeline)
        .where(and(...conditions));

      if (!existing) return sendPipelineNotFound(res);

      // Only system admins can delete non-private (public) pipelines
      if (!isSystemAdmin(req) && existing.accessModifier !== 'private') {
        ctx.log('INFO', 'Non-system-admin denied deletion of non-private pipeline', {
          id, accessModifier: existing.accessModifier,
        });
        return res.status(403).json({
          success: false,
          statusCode: 403,
          error: 'Only system admins can delete public pipelines.',
          code: ErrorCode.INSUFFICIENT_PERMISSIONS,
        });
      }

      await db
        .delete(schema.pipeline)
        .where(and(...conditions));

      ctx.log('COMPLETED', 'Deleted pipeline', { id, name: existing.pipelineName });

      return res.status(200).json({ success: true, statusCode: 200, message: 'Pipeline deleted.' });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
