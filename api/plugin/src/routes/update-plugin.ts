/**
 * @module routes/update-plugin
 * @description Plugin update.
 *
 * PUT /plugins/:id — update a plugin by its UUID
 */

import { getParam, ErrorCode, isSystemAdmin, errorMessage, sendBadRequest, sendError, sendInternalError } from '@mwashburn160/api-core';
import { createRequestContext, SSEManager } from '@mwashburn160/api-server';
import { db, schema, buildPluginConditions } from '@mwashburn160/pipeline-core';
import { and } from 'drizzle-orm';
import { Router, Request, Response } from 'express';
import {
  buildUpdateData,
  normalizePlugin,
  sendPluginNotFound,
  PluginUpdateBody,
} from '../helpers/plugin-helpers';

/**
 * Register the UPDATE route on a router.
 *
 * Expects `authenticateToken` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createUpdatePluginRoutes(sseManager: SSEManager): Router {
  const router: Router = Router();

  router.put('/:id', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Plugin update request received', { id });

    try {
      const conditions = buildPluginConditions({ id }, ctx.identity.orgId!);
      const [existing] = await db
        .select()
        .from(schema.plugin)
        .where(and(...conditions));

      if (!existing) return sendPluginNotFound(res);

      // Only system admins can edit non-private plugins
      if (!isSystemAdmin(req) && existing.accessModifier !== 'private') {
        ctx.log('INFO', 'Non-system-admin denied edit of non-private plugin', {
          id, accessModifier: existing.accessModifier,
        });
        return sendError(res, 403, 'Only system admins can edit public plugins.', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }

      const { data: updateData, error: validationError } = buildUpdateData(
        req.body as PluginUpdateBody,
        ctx.identity.userId || 'system',
      );

      if (validationError) return sendBadRequest(res, validationError);

      const [updated] = await db
        .update(schema.plugin)
        .set(updateData)
        .where(and(...conditions))
        .returning();

      ctx.log('COMPLETED', 'Updated plugin', { id: updated.id, name: updated.name });

      return res.status(200).json({ success: true, statusCode: 200, plugin: normalizePlugin(updated) });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
