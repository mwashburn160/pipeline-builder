import { sendBadRequest, sendSuccess, ErrorCode, createLogger } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { pluginService } from '../services/plugin-service';

const logger = createLogger('bulk-plugin');

/**
 * Register bulk operation routes for plugins.
 * Requires auth + orgId middleware applied at the parent level.
 */
export function createBulkPluginRoutes(): Router {
  const router: Router = Router();

  /** POST /plugins/bulk/delete — Soft-delete multiple plugins by ID */
  router.post('/bulk/delete', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return sendBadRequest(res, 'Request body must include a non-empty "ids" array', ErrorCode.VALIDATION_ERROR);
    }

    if (ids.length > 100) {
      return sendBadRequest(res, 'Maximum 100 items per bulk operation', ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('INFO', 'Bulk delete plugins', { count: ids.length });

    const deleted = await pluginService.bulkDelete(ids, orgId, userId);

    ctx.log('COMPLETED', 'Bulk delete complete', { requested: ids.length, deleted: deleted.length });

    sendSuccess(res, 200, { deleted: deleted.length, ids: deleted.map(d => d.id) });
  }));

  /** PUT /plugins/bulk/update — Update multiple plugins with the same data */
  router.put('/bulk/update', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const { ids, data } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return sendBadRequest(res, 'Request body must include a non-empty "ids" array', ErrorCode.VALIDATION_ERROR);
    }

    if (ids.length > 100) {
      return sendBadRequest(res, 'Maximum 100 items per bulk operation', ErrorCode.VALIDATION_ERROR);
    }

    if (!data || typeof data !== 'object') {
      return sendBadRequest(res, 'Request body must include a "data" object with fields to update', ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('INFO', 'Bulk update plugins', { count: ids.length });

    const updated = await pluginService.updateMany(
      { id: ids } as any,
      data,
      orgId,
      userId,
    );

    ctx.log('COMPLETED', 'Bulk update complete', { requested: ids.length, updated: updated.length });

    sendSuccess(res, 200, { updated: updated.length });
  }));

  return router;
}
