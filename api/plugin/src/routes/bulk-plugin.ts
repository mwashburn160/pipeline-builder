// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendBadRequest, sendSuccess, ErrorCode } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { CoreConstants } from '@mwashburn160/pipeline-core';
import { Router } from 'express';
import { pluginService } from '../services/plugin-service';


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

    if (ids.length > CoreConstants.MAX_BULK_ITEMS) {
      return sendBadRequest(res, `Maximum ${CoreConstants.MAX_BULK_ITEMS} items per bulk operation`, ErrorCode.VALIDATION_ERROR);
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

    if (ids.length > CoreConstants.MAX_BULK_ITEMS) {
      return sendBadRequest(res, `Maximum ${CoreConstants.MAX_BULK_ITEMS} items per bulk operation`, ErrorCode.VALIDATION_ERROR);
    }

    if (!data || typeof data !== 'object') {
      return sendBadRequest(res, 'Request body must include a "data" object with fields to update', ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('INFO', 'Bulk update plugins', { count: ids.length });

    const updated = await pluginService.updateMany(
      { id: ids } as unknown as Record<string, unknown>,
      data,
      orgId,
      userId,
    );

    ctx.log('COMPLETED', 'Bulk update complete', { requested: ids.length, updated: updated.length });

    sendSuccess(res, 200, { updated: updated.length });
  }));

  return router;
}
