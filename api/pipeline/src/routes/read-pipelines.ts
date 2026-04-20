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
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
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
  router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await pipelineService.findById(id, orgId);

    if (!result) return sendEntityNotFound(res, 'Pipeline');

    if (!requirePublicAccess(req, res, result)) return;

    ctx.log('COMPLETED', 'Retrieved pipeline', { id: result.id, name: result.pipelineName });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_DETAIL);

    return sendSuccess(res, 200, { pipeline: normalizeArrayFields(result, ['keywords']) });
  }));

  return router;
}
