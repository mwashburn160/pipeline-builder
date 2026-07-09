// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, sendBadRequest, sendSuccess, sendPaginatedNested, parsePaginationParams, validateQuery, PluginFilterSchema, sendEntityNotFound } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, incrementQuotaFromCtx } from '@pipeline-builder/api-server';
import type { RequestContext } from '@pipeline-builder/api-server';
import { CoreConstants, withTenantTx } from '@pipeline-builder/pipeline-core';
import type { PluginFilter } from '@pipeline-builder/pipeline-core';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { pluginService } from '../services/plugin-service.js';

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
  router.get('/plugin-usage', withRoute(async ({ res, ctx }) => {
    // RLS-ready: `withTenantTx` SET LOCALs `app.org_id`, so once
    // FORCE ROW LEVEL SECURITY is enabled the RLS policy on `pipelines`
    // will scope this query to the caller's org without an explicit
    // org_id predicate in the SQL.
    const rows = await withTenantTx(async (tx) => tx.execute<{ name: string; cnt: string | number }>(sql`
      SELECT step->'plugin'->>'name' AS name,
             COUNT(DISTINCT p.id) AS cnt
        FROM pipelines p,
             jsonb_array_elements(COALESCE(p.props->'stages', '[]'::jsonb)) AS stage,
             jsonb_array_elements(COALESCE(stage->'steps', '[]'::jsonb)) AS step
       WHERE p.is_active = true
         AND step->'plugin'->>'name' IS NOT NULL
       GROUP BY step->'plugin'->>'name'
    `));
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

    // Org → team hierarchy: a team org also sees its parent's public plugins.
    // `parentOrganizationId` rides in the JWT (absent for root orgs), so this
    // is a no-op for non-team callers.
    const parentOrgId = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;

    const result = await pluginService.findPaginated(
      filter.value,
      orgId,
      { limit, offset, sortBy, sortOrder, includeTotal, cursor, fields },
      parentOrgId,
    );

    ctx.log('COMPLETED', 'Listed plugins', { count: result.data.length, ...(result.total !== undefined && { total: result.total }) });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);

    return sendPaginatedNested(res, 'plugins', result.data.map(r => shapePlugin(r)), {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore, nextCursor: result.nextCursor,
    });
  }));

  // Shared single-plugin lookup. `/lookup` POST takes the filter from the
  // body; `/find` GET reads it from query string. Same `PluginFilterSchema`
  // whitelist as the listing endpoint so callers can't smuggle internal
  // fields (`deletedAt`, `orgId`) to peek at soft-deleted rows.
  const respondWithSinglePlugin = async (
    filter: PluginFilter,
    req: Request, res: Response, orgId: string,
    ctx: RequestContext,
    setCacheHeader: boolean,
  ) => {
    // Org → team hierarchy: a team org also sees its parent's public plugins
    // (mirrors the list path). No-op for root orgs (claim absent).
    const parentOrgId = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
    const plugins = await pluginService.find(filter, orgId, parentOrgId);
    const result = plugins[0];
    if (!result) return sendEntityNotFound(res, 'Plugin');
    ctx.log('COMPLETED', 'Plugin lookup', { id: result.id, name: result.name });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');
    if (setCacheHeader) res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);
    return sendSuccess(res, 200, { plugin: shapePlugin(result) });
  };

  router.post('/lookup', withRoute(async ({ req, res, ctx, orgId }) => {
    const { filter } = req.body ?? {};
    if (!filter || typeof filter !== 'object') return sendBadRequest(res, 'Filter is required in request body', ErrorCode.MISSING_REQUIRED_FIELD);
    const parsed = PluginFilterSchema.safeParse(filter);
    if (!parsed.success) return sendBadRequest(res, `Invalid filter: ${parsed.error.message}`, ErrorCode.VALIDATION_ERROR);
    return respondWithSinglePlugin(parsed.data as PluginFilter, req, res, orgId, ctx, false);
  }));

  // GET /plugins/find — single plugin by filter
  router.get('/find', withRoute(async ({ req, res, ctx, orgId }) => {
    const validated = validateQuery(req, PluginFilterSchema);
    if (!validated.ok) return sendBadRequest(res, validated.error);
    return respondWithSinglePlugin(validated.value as PluginFilter, req, res, orgId, ctx, true);
  }));

  // GET /plugins/:id — single plugin by UUID
  router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Org → team hierarchy: a team org also fetches its parent's public plugins
    // by id (mirrors the list path). No-op for root orgs (claim absent).
    const parentOrgId = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
    const result = await pluginService.findById(id, orgId, parentOrgId);

    if (!result) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_DETAIL);

    return sendSuccess(res, 200, { plugin: shapePlugin(result) });
  }));

  return router;
}
