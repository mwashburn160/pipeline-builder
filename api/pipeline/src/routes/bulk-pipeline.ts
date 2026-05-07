// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendBadRequest, sendSuccess, ErrorCode, errorMessage, resolveAccessModifier } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { CoreConstants, AccessModifier, replaceNonAlphanumeric } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { pipelineService, type PipelineInsert } from '../services/pipeline-service';


/**
 * Register bulk operation routes for pipelines.
 * Requires auth + orgId middleware applied at the parent level.
 */
export function createBulkPipelineRoutes(): Router {
  const router: Router = Router();

  /** POST /pipelines/bulk/create — Create multiple pipelines in one request */
  router.post('/bulk/create', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const { pipelines } = req.body;

    if (!Array.isArray(pipelines) || pipelines.length === 0) {
      return sendBadRequest(res, 'Request body must include a non-empty "pipelines" array', ErrorCode.VALIDATION_ERROR);
    }

    if (pipelines.length > CoreConstants.MAX_BULK_ITEMS) {
      return sendBadRequest(res, `Maximum ${CoreConstants.MAX_BULK_ITEMS} items per bulk operation`, ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('INFO', 'Bulk create pipelines', { count: pipelines.length });

    const results: { created: number; failed: number; errors: Array<{ index: number; error: string }> } = {
      created: 0,
      failed: 0,
      errors: [],
    };

    for (let i = 0; i < pipelines.length; i++) {
      const body = pipelines[i];
      try {
        const accessModifier = resolveAccessModifier(req, body.accessModifier);
        const project = replaceNonAlphanumeric(body.project || '', '_').toLowerCase();
        const organization = replaceNonAlphanumeric(body.organization || '', '_').toLowerCase();

        if (!project.replace(/_/g, '') || !organization.replace(/_/g, '')) {
          results.failed++;
          results.errors.push({ index: i, error: 'Project and organization must contain alphanumeric characters' });
          continue;
        }

        const pipelineName = body.pipelineName ?? `${organization}-${project}-pipeline`;

        await pipelineService.createAsDefault(
          {
            orgId,
            project,
            organization,
            pipelineName,
            description: body.description ?? '',
            keywords: body.keywords ?? [],
            props: body.props as unknown as PipelineInsert['props'],
            accessModifier: accessModifier as AccessModifier,
            createdBy: userId || 'system',
          },
          userId || 'system',
          project,
          organization,
        );

        results.created++;
      } catch (err) {
        results.failed++;
        results.errors.push({ index: i, error: errorMessage(err) });
      }
    }

    ctx.log('COMPLETED', 'Bulk create complete', { created: results.created, failed: results.failed });

    sendSuccess(res, 201, results);
  }));

  /** POST /pipelines/bulk/delete — Soft-delete multiple pipelines by ID */
  router.post('/bulk/delete', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return sendBadRequest(res, 'Request body must include a non-empty "ids" array', ErrorCode.VALIDATION_ERROR);
    }

    if (ids.length > CoreConstants.MAX_BULK_ITEMS) {
      return sendBadRequest(res, `Maximum ${CoreConstants.MAX_BULK_ITEMS} items per bulk operation`, ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('INFO', 'Bulk delete pipelines', { count: ids.length });

    const deleted = await pipelineService.bulkDelete(ids, orgId, userId);

    ctx.log('COMPLETED', 'Bulk delete complete', { requested: ids.length, deleted: deleted.length });

    sendSuccess(res, 200, { deleted: deleted.length, ids: deleted.map(d => d.id) });
  }));

  /** PUT /pipelines/bulk/update — Update multiple pipelines with the same data */
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

    ctx.log('INFO', 'Bulk update pipelines', { count: ids.length });

    const updated = await pipelineService.updateMany(
      { id: ids },
      data,
      orgId,
      userId,
    );

    ctx.log('COMPLETED', 'Bulk update complete', { requested: ids.length, updated: updated.length });

    sendSuccess(res, 200, { updated: updated.length });
  }));

  return router;
}
