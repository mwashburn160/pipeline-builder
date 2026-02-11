/**
 * @module routes/read-plugins
 * @description Read-only plugin routes using service layer.
 *
 * GET /plugins        — paginated list with filters and sorting
 * GET /plugins/find   — find single plugin by query-string filters
 * GET /plugins/:id    — get a plugin by UUID
 */

import { getParam, ErrorCode, isSystemAdmin, errorMessage, sendBadRequest, sendInternalError, parsePaginationParams } from '@mwashburn160/api-core';
import { createRequestContext, SSEManager, QuotaService } from '@mwashburn160/api-server';
import { Router, Request, Response } from 'express';
import {
  validateFilter,
  normalizePlugin,
  sendPluginNotFound,
} from '../helpers/plugin-helpers';
import { pluginService } from '../services/plugin-service';

/**
 * Register all read routes on a router.
 *
 * Expects middleware: authenticateToken, requireOrgId, checkQuota('apiCalls')
 */
export function createReadPluginRoutes(
  sseManager: SSEManager,
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // -------------------------------------------------------------------------
  // GET /plugins — paginated list
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);

    try {
      const filter = validateFilter(req);
      if (!filter.ok) return sendBadRequest(res, filter.error);

      // Non-system-admins can only view private (org-scoped) plugins
      const effectiveFilter = !isSystemAdmin(req)
        ? { ...filter.value, accessModifier: 'private' as const }
        : filter.value;

      const { limit, offset, sortBy, sortOrder } = parsePaginationParams(
        req.query as Record<string, unknown>,
      );

      // Use service with built-in pagination and sorting
      const result = await pluginService.findPaginated(
        effectiveFilter,
        ctx.identity.orgId!,
        { limit, offset, sortBy, sortOrder },
      );

      ctx.log('COMPLETED', 'Listed plugins', { count: result.data.length, total: result.total });
      void quotaService.increment(ctx.identity.orgId!, 'apiCalls', req.headers.authorization || '');

      return res.status(200).json({
        success: true,
        statusCode: 200,
        plugins: result.data.map(normalizePlugin),
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
  // GET /plugins/find — single plugin by filter
  // -------------------------------------------------------------------------
  router.get('/find', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);

    try {
      const filter = validateFilter(req);
      if (!filter.ok) return sendBadRequest(res, filter.error);

      // Non-system-admins can only view private (org-scoped) plugins
      const effectiveFilter = !isSystemAdmin(req)
        ? { ...filter.value, accessModifier: 'private' as const }
        : filter.value;

      const plugins = await pluginService.find(effectiveFilter, ctx.identity.orgId!);
      const result = plugins[0];

      if (!result) return sendPluginNotFound(res);

      ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
      void quotaService.increment(ctx.identity.orgId!, 'apiCalls', req.headers.authorization || '');

      return res.status(200).json({ success: true, statusCode: 200, plugin: normalizePlugin(result) });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  // -------------------------------------------------------------------------
  // GET /plugins/:id — single plugin by UUID
  // -------------------------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response) => {
    const ctx = createRequestContext(req, res, sseManager);
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      const result = await pluginService.findById(id, ctx.identity.orgId!);

      if (!result) return sendPluginNotFound(res);

      // System admins can view all plugins; regular users only private ones
      if (!isSystemAdmin(req) && result.accessModifier !== 'private') {
        return sendPluginNotFound(res);
      }

      ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });
      void quotaService.increment(ctx.identity.orgId!, 'apiCalls', req.headers.authorization || '');

      return res.status(200).json({ success: true, statusCode: 200, plugin: normalizePlugin(result) });
    } catch (error) {
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
