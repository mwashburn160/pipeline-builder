import { getParam, ErrorCode, applyAccessControl, sendBadRequest, sendSuccess, parsePaginationParams, incrementQuota, validateQuery, PluginFilterSchema, normalizeArrayFields, sendEntityNotFound } from '@mwashburn160/api-core';
import type { QuotaService } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { CoreConstants } from '@mwashburn160/pipeline-core';
import { Router } from 'express';
import { pluginService } from '../services/plugin-service';

export function createReadPluginRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // GET /plugins — paginated list
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateQuery(req, PluginFilterSchema);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const effectiveFilter = applyAccessControl(filter.value, req);

    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(
      req.query as Record<string, unknown>,
    );

    const includeTotal = req.query.includeTotal === 'true';
    const cursor = req.query.cursor as string | undefined;
    const fields = req.query.fields ? (req.query.fields as string).split(',') : undefined;

    const result = await pluginService.findPaginated(
      effectiveFilter,
      orgId,
      { limit, offset, sortBy, sortOrder, includeTotal, cursor, fields },
    );

    ctx.log('COMPLETED', 'Listed plugins', { count: result.data.length, ...(result.total !== undefined && { total: result.total }) });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);

    return sendSuccess(res, 200, {
      plugins: result.data.map(r => normalizeArrayFields(r, ['keywords', 'installCommands', 'commands'])),
      pagination: {
        ...(result.total !== undefined && { total: result.total }),
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
        ...(result.nextCursor && { nextCursor: result.nextCursor }),
      },
    });
  }));

  router.post('/lookup', withRoute(async ({ req, res, ctx, orgId }) => {
    const { filter } = req.body;
    if (!filter || typeof filter !== 'object') return sendBadRequest(res, 'Filter is required in request body', ErrorCode.MISSING_REQUIRED_FIELD);

    const effectiveFilter = applyAccessControl(filter, req);
    const plugins = await pluginService.find(effectiveFilter, orgId);
    const result = plugins[0];

    if (!result) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Plugin lookup', { id: result.id, name: result.name });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { plugin: normalizeArrayFields(result, ['keywords', 'installCommands', 'commands']) });
  }));

  // GET /plugins/find — single plugin by filter
  router.get('/find', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateQuery(req, PluginFilterSchema);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const effectiveFilter = applyAccessControl(filter.value, req);

    const plugins = await pluginService.find(effectiveFilter, orgId);
    const result = plugins[0];

    if (!result) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

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
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_DETAIL);

    return sendSuccess(res, 200, { plugin: normalizeArrayFields(result, ['keywords', 'installCommands', 'commands']) });
  }));

  return router;
}
