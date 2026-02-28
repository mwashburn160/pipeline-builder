/**
 * @module routes/read-pipelines
 * @description Read-only pipeline routes using service layer.
 *
 * GET /pipelines        — paginated list with filters and sorting
 * GET /pipelines/find   — find single pipeline by query-string filters
 * GET /pipelines/:id    — get a pipeline by UUID
 */

import { getParam, ErrorCode, applyAccessControl, requirePublicAccess, sendBadRequest, sendSuccess, parsePaginationParams, incrementQuota } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import type { QuotaService } from '@mwashburn160/api-server';
import { Router } from 'express';
import {
  validateFilter,
  normalizePipeline,
  sendPipelineNotFound,
} from '../helpers/pipeline-helpers';
import { pipelineService } from '../services/pipeline-service';

/**
 * Register all read routes on a router.
 *
 * Expects middleware: requireAuth, requireOrgId, checkQuota('apiCalls')
 * Context is automatically attached via attachRequestContext middleware
 */
export function createReadPipelineRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // -------------------------------------------------------------------------
  // GET /pipelines — paginated list
  // -------------------------------------------------------------------------
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateFilter(req);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    // Non-system-admins can only view private (org-scoped) pipelines
    const effectiveFilter = applyAccessControl(filter.value, req);

    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(
      req.query as Record<string, unknown>,
    );

    // Use service with built-in pagination and sorting
    const result = await pipelineService.findPaginated(
      effectiveFilter,
      orgId,
      { limit, offset, sortBy, sortOrder },
    );

    ctx.log('COMPLETED', 'Listed pipelines', { count: result.data.length, total: result.total });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, {
      pipelines: result.data.map(normalizePipeline),
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    });
  }));

  // -------------------------------------------------------------------------
  // GET /pipelines/find — single pipeline by filter
  // -------------------------------------------------------------------------
  router.get('/find', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateFilter(req);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    // Non-system-admins can only view private (org-scoped) pipelines
    const effectiveFilter = applyAccessControl(filter.value, req);

    const pipelines = await pipelineService.find(effectiveFilter, orgId);
    const result = pipelines[0];

    if (!result) return sendPipelineNotFound(res);

    ctx.log('COMPLETED', 'Retrieved pipeline', { id: result.id, name: result.pipelineName });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { pipeline: normalizePipeline(result) });
  }));

  // -------------------------------------------------------------------------
  // GET /pipelines/:id — single pipeline by UUID
  // -------------------------------------------------------------------------
  router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await pipelineService.findById(id, orgId);

    if (!result) return sendPipelineNotFound(res);

    // System admins can view all pipelines; regular users only private ones
    if (!requirePublicAccess(req, res, result)) return;

    ctx.log('COMPLETED', 'Retrieved pipeline', { id: result.id, name: result.pipelineName });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { pipeline: normalizePipeline(result) });
  }));

  return router;
}
