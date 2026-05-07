// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendBadRequest, sendSuccess, ErrorCode } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { z } from 'zod';
import { pluginService } from '../services/plugin-service';

/**
 * Whitelist of plugin fields that may be set via bulk update.
 * Excludes `orgId`, `id`, `createdAt`, `createdBy`, `deletedAt`, `imageTag` —
 * those are either tenancy boundaries, immutable, or set by build pipeline.
 */
const BulkPluginUpdateDataSchema = z.object({
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  keywords: z.array(z.string()).optional(),
  accessModifier: z.enum(['public', 'private']).optional(),
}).strict();


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

    // Validate the update payload against a strict whitelist — without this,
    // a caller could write internal fields (orgId, deletedAt, imageTag) on
    // every plugin in the org with one call.
    const dataValidation = BulkPluginUpdateDataSchema.safeParse(data);
    if (!dataValidation.success) {
      return sendBadRequest(res, `Invalid update data: ${dataValidation.error.message}`, ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('INFO', 'Bulk update plugins', { count: ids.length });

    const updated = await pluginService.updateMany(
      { id: ids },
      dataValidation.data,
      orgId,
      userId,
    );

    ctx.log('COMPLETED', 'Bulk update complete', { requested: ids.length, updated: updated.length });

    sendSuccess(res, 200, { updated: updated.length });
  }));

  return router;
}
