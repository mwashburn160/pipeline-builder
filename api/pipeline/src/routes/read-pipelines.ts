/**
 * @module routes/read-pipelines
 * @description Read-only pipeline routes.
 *
 * GET /pipelines        — paginated list with filters and sorting
 * GET /pipelines/find   — find single pipeline by query-string filters
 * GET /pipelines/:id    — get a pipeline by UUID
 */

import { getParam, ErrorCode, isSystemAdmin } from '@mwashburn160/api-core';
import { createRequestContext, SSEManager, QuotaService } from '@mwashburn160/api-server';
import { db, schema, buildPipelineConditions } from '@mwashburn160/pipeline-core';
import { and, sql } from 'drizzle-orm';
import { Router, Request, Response } from 'express';
import {
  parsePaginationParams,
  resolveOrderBy,
  validateFilter,
  normalizePipeline,
  errorMessage,
  sendBadRequest,
  sendPipelineNotFound,
  sendInternalError,
} from '../helpers/pipeline-helpers';

/**
 * Register all read routes on a router.
 *
 * Expects `authenticateToken`, `requireOrgId`, and `checkQuota('apiCalls')`
 * to have already been applied as router-level middleware in the parent.
 */
export function createReadPipelineRoutes(
  sseManager: SSEManager,
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // -------------------------------------------------------------------------
  // GET /pipelines — paginated list
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);

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

      const conditions = buildPipelineConditions(effectiveFilter, ctx.identity.orgId!);

      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.pipeline)
        .where(and(...conditions));

      const total = countResult?.count || 0;

      const results = await db
        .select()
        .from(schema.pipeline)
        .where(and(...conditions))
        .orderBy(resolveOrderBy(sortBy, sortOrder))
        .limit(limit)
        .offset(offset);

      ctx.log('COMPLETED', 'Listed pipelines', { count: results.length, total });
      void quotaService.increment(ctx.identity.orgId!, 'apiCalls', req.headers.authorization || '');

      return res.status(200).json({
        success: true,
        statusCode: 200,
        pipelines: results.map(normalizePipeline),
        pagination: { total, limit, offset, hasMore: offset + results.length < total },
      });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  // -------------------------------------------------------------------------
  // GET /pipelines/find — single pipeline by filter
  // -------------------------------------------------------------------------
  router.get('/find', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);

    try {
      const filter = validateFilter(req);
      if (!filter.ok) return sendBadRequest(res, filter.error);

      // Non-system-admins can only view private (org-scoped) pipelines
      const effectiveFilter = !isSystemAdmin(req)
        ? { ...filter.value, accessModifier: 'private' as const }
        : filter.value;

      const conditions = buildPipelineConditions(effectiveFilter, ctx.identity.orgId!);
      return await findOne(req, res, ctx, conditions, quotaService);
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  // -------------------------------------------------------------------------
  // GET /pipelines/:id — single pipeline by UUID
  // -------------------------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      const filter: Record<string, string> = { id };
      // Non-system-admins can only view private (org-scoped) pipelines
      if (!isSystemAdmin(req)) {
        filter.accessModifier = 'private';
      }
      const conditions = buildPipelineConditions(filter, ctx.identity.orgId!);
      return await findOne(req, res, ctx, conditions, quotaService);
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Shared single-result query used by both /find and /:id. */
async function findOne(
  req: Request,
  res: Response,
  ctx: ReturnType<typeof createRequestContext>,
  conditions: ReturnType<typeof buildPipelineConditions>,
  quotaService: QuotaService,
): Promise<Response> {
  const [result] = await db
    .select()
    .from(schema.pipeline)
    .where(and(...conditions))
    .limit(1);

  if (!result) return sendPipelineNotFound(res);

  ctx.log('COMPLETED', 'Retrieved pipeline', { id: result.id, name: result.pipelineName });
  void quotaService.increment(ctx.identity.orgId!, 'apiCalls', req.headers.authorization || '');

  return res.status(200).json({ success: true, statusCode: 200, pipeline: normalizePipeline(result) });
}
