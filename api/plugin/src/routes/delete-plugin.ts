import { getParam, ErrorCode, requirePublicAccess, sendBadRequest, sendSuccess } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { sendPluginNotFound } from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';

/**
 * Register the DELETE route on a router.
 *
 * Expects `requireAuth` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createDeletePluginRoutes(): Router {
  const router: Router = Router();

  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Plugin delete request received', { id });

    const existing = await pluginService.findById(id, orgId);

    if (!existing) return sendPluginNotFound(res);

    // Only system admins can delete non-private (public) plugins
    if (!requirePublicAccess(req, res, existing)) return;

    await pluginService.delete(id, orgId, userId || 'system');

    ctx.log('COMPLETED', 'Deleted plugin', { id, name: existing.name });

    return sendSuccess(res, 200, undefined, 'Plugin deleted.');
  }));

  return router;
}
