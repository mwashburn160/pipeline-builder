// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  getParam,
  ErrorCode,
  applyAccessControl,
  requirePublicAccess,
  sendBadRequest,
  sendSuccess,
  sendPaginatedNested,
  sendEntityNotFound,
  parsePaginationParams,
  normalizeArrayFields,
  validateQuery,
  PipelineFilterSchema,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, incrementQuotaFromCtx } from '@pipeline-builder/api-server';
import { CoreConstants, db } from '@pipeline-builder/pipeline-core';
import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { resolvePipeline, type PipelineLike } from '../helpers/pipeline-template-validator';
import { pipelineService } from '../services/pipeline-service';

export function createReadPipelineRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // GET /pipelines — paginated list
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateQuery(req, PipelineFilterSchema);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const effectiveFilter = applyAccessControl(filter.value, req);

    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(
      req.query as Record<string, unknown>,
    );

    const includeTotal = req.query.includeTotal === 'true';
    const cursor = req.query.cursor as string | undefined;
    const fields = req.query.fields ? (req.query.fields as string).split(',') : undefined;

    const result = await pipelineService.findPaginated(
      effectiveFilter,
      orgId,
      { limit, offset, sortBy, sortOrder, includeTotal, cursor, fields },
    );

    ctx.log('COMPLETED', 'Listed pipelines', { count: result.data.length, ...(result.total !== undefined && { total: result.total }) });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);

    return sendPaginatedNested(res, 'pipelines', result.data.map(r => normalizeArrayFields(r, ['keywords'])), {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore, nextCursor: result.nextCursor,
    });
  }));

  // GET /pipelines/plugin-usage — counts pipelines (in caller's org) that
  // reference each plugin name. Used by the plugin-list "Used by N pipelines"
  // badge. Returns { counts: { [pluginName]: number } }; plugins with zero
  // usage are absent from the map.
  router.get('/plugin-usage', withRoute(async ({ res, ctx, orgId }) => {
    const rows = await db.execute<{ name: string; cnt: string | number }>(sql`
      SELECT step->'plugin'->>'name' AS name,
             COUNT(DISTINCT p.id) AS cnt
        FROM pipeline p,
             jsonb_array_elements(COALESCE(p.props->'stages', '[]'::jsonb)) AS stage,
             jsonb_array_elements(COALESCE(stage->'steps', '[]'::jsonb)) AS step
       WHERE p.org_id = ${orgId.toLowerCase()}
         AND p.is_active = true
         AND step->'plugin'->>'name' IS NOT NULL
       GROUP BY step->'plugin'->>'name'
    `);
    const counts: Record<string, number> = {};
    for (const row of rows.rows ?? rows as unknown as Array<{ name: string; cnt: string | number }>) {
      const n = typeof row.cnt === 'number' ? row.cnt : parseInt(String(row.cnt), 10);
      if (row.name && Number.isFinite(n)) counts[row.name] = n;
    }
    ctx.log('COMPLETED', 'Computed plugin usage', { distinct: Object.keys(counts).length });
    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);
    return sendSuccess(res, 200, { counts });
  }));

  // GET /pipelines/find — single pipeline by filter
  router.get('/find', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateQuery(req, PipelineFilterSchema);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const effectiveFilter = applyAccessControl(filter.value, req);

    const pipelines = await pipelineService.find(effectiveFilter, orgId);
    const result = pipelines[0];

    if (!result) return sendEntityNotFound(res, 'Pipeline');

    ctx.log('COMPLETED', 'Retrieved pipeline', { id: result.id, name: result.pipelineName });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);

    return sendSuccess(res, 200, { pipeline: normalizeArrayFields(result, ['keywords']) });
  }));

  // GET /pipelines/:id — single pipeline by UUID
  // ?resolve=true resolves pipeline-level {{ ... }} templates before returning.
  router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await pipelineService.findById(id, orgId);

    if (!result) return sendEntityNotFound(res, 'Pipeline');

    if (!requirePublicAccess(req, res, result)) return;

    ctx.log('COMPLETED', 'Retrieved pipeline', { id: result.id, name: result.pipelineName });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_DETAIL);

    // Template resolution: off by default; opt in with ?resolve=true.
    // Returns the pipeline with metadata/vars placeholders expanded in place.
    const shouldResolve = req.query.resolve === 'true';
    const payload = normalizeArrayFields(result, ['keywords']);
    if (shouldResolve) {
      try {
        resolvePipeline(payload as unknown as PipelineLike);
      } catch (err) {
        return sendBadRequest(res, (err as Error).message, ErrorCode.TEMPLATE_VALIDATION_FAILED);
      }
    }

    return sendSuccess(res, 200, { pipeline: payload });
  }));

  return router;
}
