/**
 * @module routes/read-pipelines
 * @description Read-only pipeline routes using service layer.
 *
 * GET /pipelines        — paginated list with filters and sorting
 * GET /pipelines/find   — find single pipeline by query-string filters
 * GET /pipelines/:id    — get a pipeline by UUID
 */

import { getParam, ErrorCode, isSystemAdmin, errorMessage, sendBadRequest, sendInternalError, parsePaginationParams } from '@mwashburn160/api-core';
import { SSEManager, QuotaService } from '@mwashburn160/api-server';
import { Router, Request, Response } from 'express';
import {
  validateFilter,
  normalizePipeline,
  sendPipelineNotFound,
} from '../helpers/pipeline-helpers';
import { pipelineService } from '../services/pipeline-service';

/**
 * Register all read routes on a router.
 *
 * Expects middleware: authenticateToken, requireOrgId, checkQuota('apiCalls')
 * Context is automatically attached via attachRequestContext middleware
 */
export function createReadPipelineRoutes(
  sseManager: SSEManager,
  quotaService: QuotaService,
): Router {
  const router: Router = Router();
  // sseManager kept in signature for backward compatibility but not used (context middleware handles it)
  void sseManager;

  // -------------------------------------------------------------------------
  // GET /pipelines — paginated list
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    const ctx = req.context!;

    try {
      const filter = validateFilter(req);
      if (!filter.ok) return sendBadRequest(res, filter.error);

      // Non-system-admins can only view private (org-scoped) pipelines
      const effectiveFilter = !isSystemAdmin(req)
        ? { ...filter.value, accessModifier: 'private' as const }
        : filter.value;

      const { limit, offset, sortBy, sortOrder } = parsePaginationParams(
        req.query as Record<string, unknown>,
      );

      // Use service with built-in pagination and sorting
      const result = await pipelineService.findPaginated(
        effectiveFilter,
        ctx.identity.orgId!,
        { limit, offset, sortBy, sortOrder },
      );

      ctx.log('COMPLETED', 'Listed pipelines', { count: result.data.length, total: result.total });
      void quotaService.increment(ctx.identity.orgId!, 'apiCalls', req.headers.authorization || '');

      return res.status(200).json({
        success: true,
        statusCode: 200,
        pipelines: result.data.map(normalizePipeline),
        pagination: {
          total: result.total,
          limit: result.limit,
          offset: result.offset,
          hasMore: result.hasMore,
        },
      });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  // -------------------------------------------------------------------------
  // GET /pipelines/find — single pipeline by filter
  // -------------------------------------------------------------------------
  router.get('/find', async (req: Request, res: Response) => {
    const ctx = req.context!;

    try {
      const filter = validateFilter(req);
      if (!filter.ok) return sendBadRequest(res, filter.error);

      // Non-system-admins can only view private (org-scoped) pipelines
      const effectiveFilter = !isSystemAdmin(req)
        ? { ...filter.value, accessModifier: 'private' as const }
        : filter.value;

      const pipelines = await pipelineService.find(effectiveFilter, ctx.identity.orgId!);
      const result = pipelines[0];

      if (!result) return sendPipelineNotFound(res);

      ctx.log('COMPLETED', 'Retrieved pipeline', { id: result.id, name: result.pipelineName });
      void quotaService.increment(ctx.identity.orgId!, 'apiCalls', req.headers.authorization || '');

      return res.status(200).json({ success: true, statusCode: 200, pipeline: normalizePipeline(result) });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  // -------------------------------------------------------------------------
  // GET /pipelines/:id — single pipeline by UUID
  // -------------------------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response) => {
    const ctx = req.context!;
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      const result = await pipelineService.findById(id, ctx.identity.orgId!);

      if (!result) return sendPipelineNotFound(res);

      // System admins can view all pipelines; regular users only private ones
      if (!isSystemAdmin(req) && result.accessModifier !== 'private') {
        return sendPipelineNotFound(res);
      }

      ctx.log('COMPLETED', 'Retrieved pipeline', { id: result.id, name: result.pipelineName });
      void quotaService.increment(ctx.identity.orgId!, 'apiCalls', req.headers.authorization || '');

      return res.status(200).json({ success: true, statusCode: 200, pipeline: normalizePipeline(result) });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
