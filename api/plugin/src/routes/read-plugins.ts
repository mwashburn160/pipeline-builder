// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, sendBadRequest, sendSuccess, sendPaginatedNested, parsePaginationParams, validateQuery, PluginFilterSchema, normalizeArrayFields, sendEntityNotFound } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, incrementQuotaFromCtx } from '@pipeline-builder/api-server';
import { CoreConstants, db } from '@pipeline-builder/pipeline-core';
import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { pluginService } from '../services/plugin-service';

export function createReadPluginRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // GET /plugins/plugin-usage — counts pipelines (in caller's org) that
  // reference each plugin name. Used by the plugin-list "Used by N pipelines"
  // badge. Returns { counts: { [pluginName]: number } }; plugins with zero
  // usage are absent from the map.
  //
  // Lives on the plugin service (not pipeline) because the consumer is the
  // plugins dashboard. The query reads the shared `pipeline` table via the
  // pipeline-data drizzle connection — both services share the same Postgres.
  router.get('/plugin-usage', withRoute(async ({ res, ctx, orgId }) => {
    const rows = await db.execute<{ name: string; cnt: string | number }>(sql`
      SELECT step->'plugin'->>'name' AS name,
             COUNT(DISTINCT p.id) AS cnt
        FROM pipelines p,
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

  // GET /plugins — paginated list
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateQuery(req, PluginFilterSchema);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(
      req.query as Record<string, unknown>,
    );

    const includeTotal = req.query.includeTotal === 'true';
    const cursor = req.query.cursor as string | undefined;
    const fields = req.query.fields ? (req.query.fields as string).split(',') : undefined;

    const result = await pluginService.findPaginated(
      filter.value,
      orgId,
      { limit, offset, sortBy, sortOrder, includeTotal, cursor, fields },
    );

    ctx.log('COMPLETED', 'Listed plugins', { count: result.data.length, ...(result.total !== undefined && { total: result.total }) });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);

    return sendPaginatedNested(res, 'plugins', result.data.map(r => normalizeArrayFields(r, ['keywords', 'installCommands', 'commands'])), {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore, nextCursor: result.nextCursor,
    });
  }));

  router.post('/lookup', withRoute(async ({ req, res, ctx, orgId }) => {
    const { filter } = req.body;
    if (!filter || typeof filter !== 'object') return sendBadRequest(res, 'Filter is required in request body', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate the filter shape — without this, callers can inject internal
    // fields (e.g. `deletedAt`, `orgId`) to peek at soft-deleted plugins or
    // bypass tenant scoping. PluginFilterSchema is the same whitelist the
    // GET /plugins listing uses.
    const filterValidation = PluginFilterSchema.safeParse(filter);
    if (!filterValidation.success) {
      return sendBadRequest(res, `Invalid filter: ${filterValidation.error.message}`, ErrorCode.VALIDATION_ERROR);
    }

    const plugins = await pluginService.find(filterValidation.data, orgId);
    const result = plugins[0];

    if (!result) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Plugin lookup', { id: result.id, name: result.name });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendSuccess(res, 200, { plugin: normalizeArrayFields(result, ['keywords', 'installCommands', 'commands']) });
  }));

  // GET /plugins/find — single plugin by filter
  router.get('/find', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateQuery(req, PluginFilterSchema);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const plugins = await pluginService.find(filter.value, orgId);
    const result = plugins[0];

    if (!result) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);

    return sendSuccess(res, 200, { plugin: normalizeArrayFields(result, ['keywords', 'installCommands', 'commands']) });
  }));

  // GET /plugins/:id — single plugin by UUID
  router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await pluginService.findById(id, orgId);

    if (!result) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_DETAIL);

    return sendSuccess(res, 200, { plugin: normalizeArrayFields(result, ['keywords', 'installCommands', 'commands']) });
  }));

  return router;
}
