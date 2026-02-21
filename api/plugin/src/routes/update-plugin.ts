/**
 * @module routes/update-plugin
 * @description Plugin update.
 *
 * PUT /plugins/:id — update a plugin by its UUID
 */

import { getParam, ErrorCode, isSystemAdmin, errorMessage, sendBadRequest, sendError, sendInternalError, validateBody, PluginUpdateSchema } from '@mwashburn160/api-core';
import { createRequestContext, SSEManager } from '@mwashburn160/api-server';
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
export function createUpdatePluginRoutes(sseManager: SSEManager): Router {
  const router: Router = Router();

  router.put('/:id', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod
    const validation = validateBody(req, PluginUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    if (!ctx.identity.orgId) return sendBadRequest(res, 'Organization ID is required');
    const orgId = ctx.identity.orgId;

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
        updatedAt: new Date(),
        updatedBy: ctx.identity.userId || 'system',
      };

      if (body.name !== undefined) updateData.name = body.name;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.keywords !== undefined) updateData.keywords = body.keywords;
      if (body.version !== undefined) updateData.version = body.version;
      if (body.metadata !== undefined) updateData.metadata = body.metadata;
      if (body.pluginType !== undefined) updateData.pluginType = body.pluginType;
      if (body.computeType !== undefined) updateData.computeType = body.computeType;
      if (body.primaryOutputDirectory !== undefined) updateData.primaryOutputDirectory = body.primaryOutputDirectory;
      if (body.env !== undefined) updateData.env = body.env;
      if (body.installCommands !== undefined) updateData.installCommands = body.installCommands;
      if (body.commands !== undefined) updateData.commands = body.commands;
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
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
