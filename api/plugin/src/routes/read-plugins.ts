import { getParam, ErrorCode, applyAccessControl, sendBadRequest, sendSuccess, parsePaginationParams, incrementQuota } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import type { QuotaService } from '@mwashburn160/api-server';
import { Router } from 'express';
import {
  validateFilter,
  normalizePlugin,
  sendPluginNotFound,
} from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';

export function createReadPluginRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // GET /plugins — paginated list
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateFilter(req);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const effectiveFilter = applyAccessControl(filter.value, req);

    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(
      req.query as Record<string, unknown>,
    );

    const result = await pluginService.findPaginated(
      effectiveFilter,
      orgId,
      { limit, offset, sortBy, sortOrder },
    );

    ctx.log('COMPLETED', 'Listed plugins', { count: result.data.length, total: result.total });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, {
      plugins: result.data.map(normalizePlugin),
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    });
  }));

  router.post('/lookup', withRoute(async ({ req, res, ctx, orgId }) => {
    const { filter } = req.body;
    if (!filter) return sendBadRequest(res, 'Filter is required in request body', ErrorCode.MISSING_REQUIRED_FIELD);

    const plugins = await pluginService.find(filter, orgId);
    const result = plugins[0];

    if (!result) return sendPluginNotFound(res);

    ctx.log('COMPLETED', 'Plugin lookup', { id: result.id, name: result.name });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { plugin: normalizePlugin(result) });
  }));

  // GET /plugins/find — single plugin by filter
  router.get('/find', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateFilter(req);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const effectiveFilter = applyAccessControl(filter.value, req);

    const plugins = await pluginService.find(effectiveFilter, orgId);
    const result = plugins[0];

    if (!result) return sendPluginNotFound(res);

    ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { plugin: normalizePlugin(result) });
  }));

  // GET /plugins/:id — single plugin by UUID
  router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await pluginService.findById(id, orgId);

    if (!result) return sendPluginNotFound(res);

    ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { plugin: normalizePlugin(result) });
  }));

  return router;
}
