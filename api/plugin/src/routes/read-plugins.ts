/**
 * @module routes/read-plugins
 * @description Read-only plugin routes using service layer.
 *
 * GET  /plugins        — paginated list with filters and sorting
 * POST /plugins/lookup — find single plugin by body filter (used by CDK Lambda handler)
 * GET  /plugins/find   — find single plugin by query-string filters
 * GET  /plugins/:id    — get a plugin by UUID
 */

import { getParam, ErrorCode, applyAccessControl, isSystemAdmin, sendBadRequest, sendSuccess, parsePaginationParams, incrementQuota } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import type { QuotaService } from '@mwashburn160/api-server';
import { Router } from 'express';
import {
  validateFilter,
  normalizePlugin,
  sendPluginNotFound,
} from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';

/**
 * Register all read routes on a router.
 *
 * Context is automatically attached via attachRequestContext middleware.
 * Expects middleware: requireAuth, requireOrgId, checkQuota('apiCalls')
 */
export function createReadPluginRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // -------------------------------------------------------------------------
  // GET /plugins — paginated list
  // -------------------------------------------------------------------------
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateFilter(req);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    // Non-system-admins can only view private (org-scoped) plugins
    const effectiveFilter = applyAccessControl(filter.value, req);

    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(
      req.query as Record<string, unknown>,
    );

    // Use service with built-in pagination and sorting
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

  // -------------------------------------------------------------------------
  // POST /plugins/lookup — find single plugin by body filter (CDK Lambda handler)
  // -------------------------------------------------------------------------
  router.post('/lookup', withRoute(async ({ req, res, ctx, orgId }) => {
    const { filter } = req.body;
    if (!filter) return sendBadRequest(res, 'Filter is required in request body', ErrorCode.MISSING_REQUIRED_FIELD);

    const plugins = await pluginService.find(applyAccessControl(filter, req), orgId);
    const result = plugins[0];

    if (!result) return sendPluginNotFound(res);

    ctx.log('COMPLETED', 'Plugin lookup', { id: result.id, name: result.name });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { plugin: normalizePlugin(result) });
  }));

  // -------------------------------------------------------------------------
  // GET /plugins/find — single plugin by filter
  // -------------------------------------------------------------------------
  router.get('/find', withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateFilter(req);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    // Non-system-admins can only view private (org-scoped) plugins
    const effectiveFilter = applyAccessControl(filter.value, req);

    const plugins = await pluginService.find(effectiveFilter, orgId);
    const result = plugins[0];

    if (!result) return sendPluginNotFound(res);

    ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { plugin: normalizePlugin(result) });
  }));

  // -------------------------------------------------------------------------
  // GET /plugins/:id — single plugin by UUID
  // -------------------------------------------------------------------------
  router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await pluginService.findById(id, orgId);

    if (!result) return sendPluginNotFound(res);

    // Non-system-admins can only view private (org-scoped) plugins
    if (!isSystemAdmin(req) && result.accessModifier !== 'private') {
      return sendPluginNotFound(res);
    }

    ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { plugin: normalizePlugin(result) });
  }));

  return router;
}
