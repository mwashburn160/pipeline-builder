/**
 * @module routes/delete-plugin
 * @description Plugin deletion.
 *
 * DELETE /plugins/:id — delete a plugin by its UUID
 *
 * Permissions:
 *   - System admins: can delete public and private plugins
 *   - Org admins: can delete private plugins only
 *   - Regular users: can delete private plugins only
 */

import { getParam, ErrorCode, isSystemAdmin, errorMessage, sendBadRequest, sendError, sendInternalError, sendSuccess } from '@mwashburn160/api-core';
import { Router, Request, Response } from 'express';
import { sendPluginNotFound } from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';

/**
 * Register the DELETE route on a router.
 *
 * Expects `authenticateToken` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createDeletePluginRoutes(): Router {
  const router: Router = Router();

  router.delete('/:id', async (req: Request, res: Response) => {
    const ctx = req.context!;
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const orgId = ctx.identity.orgId?.toLowerCase();
    if (!orgId) return sendBadRequest(res, 'Organization ID is required');

    ctx.log('INFO', 'Plugin delete request received', { id });

    try {
      const existing = await pluginService.findById(id, orgId);

      if (!existing) return sendPluginNotFound(res);

      // Only system admins can delete non-private (public) plugins
      if (!isSystemAdmin(req) && existing.accessModifier !== 'private') {
        ctx.log('INFO', 'Non-system-admin denied deletion of non-private plugin', {
          id, accessModifier: existing.accessModifier,
        });
        return sendError(res, 403, 'Only system admins can delete public plugins.', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }

      await pluginService.delete(id, orgId, ctx.identity.userId || 'system');

      ctx.log('COMPLETED', 'Deleted plugin', { id, name: existing.name });

      return sendSuccess(res, 200, undefined, 'Plugin deleted.');
    } catch (error) {
      ctx.log('ERROR', 'Failed to delete plugin', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
