/**
 * @module routes/update-plugin
 * @description Plugin update.
 *
 * PUT /plugins/:id — update a plugin by its UUID
 */

import { getParam, ErrorCode, isSystemAdmin, resolveAccessModifier, errorMessage, sendBadRequest, sendError, sendInternalError, validateBody, PluginUpdateSchema, pickDefined } from '@mwashburn160/api-core';
import { Router, Request, Response } from 'express';
import {
  normalizePlugin,
  sendPluginNotFound,
} from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';

/**
 * Register the UPDATE route on a router.
 *
 * Expects `authenticateToken` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createUpdatePluginRoutes(): Router {
  const router: Router = Router();

  router.put('/:id', async (req: Request, res: Response) => {
    const ctx = req.context!;
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod
    const validation = validateBody(req, PluginUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    const orgId = ctx.identity.orgId?.toLowerCase();
    if (!orgId) return sendBadRequest(res, 'Organization ID is required');

    ctx.log('INFO', 'Plugin update request received', { id });

    try {
      const existing = await pluginService.findById(id, orgId);

      if (!existing) return sendPluginNotFound(res);

      // Only system admins can edit non-private plugins
      if (!isSystemAdmin(req) && existing.accessModifier !== 'private') {
        ctx.log('INFO', 'Non-system-admin denied edit of non-private plugin', {
          id, accessModifier: existing.accessModifier,
        });
        return sendError(res, 403, 'Only system admins can edit public plugins.', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }

      // Build update data from validated body
      const updateData: Record<string, unknown> = {
        ...pickDefined({
          name: body.name,
          description: body.description,
          keywords: body.keywords,
          version: body.version,
          metadata: body.metadata,
          pluginType: body.pluginType,
          computeType: body.computeType,
          primaryOutputDirectory: body.primaryOutputDirectory,
          env: body.env,
          installCommands: body.installCommands,
          commands: body.commands,
          isActive: body.isActive,
          isDefault: body.isDefault,
        }),
        // Access modifier requires special handling (admin-only public)
        ...(body.accessModifier !== undefined ? { accessModifier: resolveAccessModifier(req, body.accessModifier) } : {}),
        updatedAt: new Date(),
        updatedBy: ctx.identity.userId || 'system',
      };

      const updated = await pluginService.update(
        id,
        updateData,
        orgId,
        ctx.identity.userId || 'system',
      );

      if (!updated) return sendPluginNotFound(res);

      ctx.log('COMPLETED', 'Updated plugin', { id: updated.id, name: updated.name });

      return res.status(200).json({ success: true, statusCode: 200, plugin: normalizePlugin(updated) });
    } catch (error) {
      ctx.log('ERROR', 'Failed to update plugin', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
