import { createLogger, sendError, sendSuccess } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import { getAuthContext } from '../helpers/controller-helper';
import {
  pluginService,
  PluginServiceError,
  PluginFilter,
} from '../utils';

const logger = createLogger('PluginController');

/**
 * Build plugin filter from request query parameters.
 */
function buildFilter(query: Request['query'], options?: { includePagination?: boolean; includeId?: boolean }): PluginFilter {
  const filter: PluginFilter = {};

  if (options?.includeId && query.id) filter.id = String(query.id);
  if (query.name) filter.name = String(query.name);
  if (query.version) filter.version = String(query.version);
  if (query.pluginType) filter.pluginType = String(query.pluginType);
  if (query.computeType) filter.computeType = String(query.computeType);

  const accessModifier = String(query.accessModifier ?? '');
  if (accessModifier === 'public' || accessModifier === 'private') {
    filter.accessModifier = accessModifier;
  }

  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (query.isDefault !== undefined) filter.isDefault = query.isDefault === 'true';

  if (options?.includePagination) {
    if (query.page) filter.page = Math.max(1, parseInt(String(query.page), 10) || 1);
    if (query.limit) filter.limit = Math.min(100, Math.max(1, parseInt(String(query.limit), 10) || 20));
  }

  return filter;
}

/**
 * Handle PluginServiceError or return generic 500 error.
 */
function handleError(res: Response, err: unknown, operation: string): void {
  if (err instanceof PluginServiceError) {
    sendError(res, err.statusCode, err.message, err.code);
  } else {
    sendError(res, 500, `Failed to ${operation}`);
  }
}

/**
 * List plugins with optional filters
 * GET /plugin
 */
export async function listPlugins(req: Request, res: Response): Promise<void> {
  const auth = getAuthContext(req, res, 'list plugins');
  if (!auth) return;

  const filter = buildFilter(req.query, { includePagination: true });

  logger.info('[LIST PLUGINS] Request received', { userId: auth.userId, orgId: auth.orgId, filter });

  try {
    const result = await pluginService.listPlugins(auth.orgId, filter, {
      userId: auth.userId,
      token: auth.token,
    });

    logger.info('[LIST PLUGINS] Success', {
      userId: auth.userId,
      orgId: auth.orgId,
      count: result.plugins.length,
      total: result.total,
    });

    res.json({ success: true, statusCode: 200, ...result });
  } catch (err) {
    logger.error('[LIST PLUGINS] Failed:', err);
    handleError(res, err, 'list plugins');
  }
}

/**
 * Get a single plugin by ID
 * GET /plugin/:id
 */
export async function getPluginById(req: Request, res: Response): Promise<void> {
  const auth = getAuthContext(req, res, 'view plugins');
  if (!auth) return;

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id) {
    return sendError(res, 400, 'Plugin ID is required');
  }

  logger.info('[GET PLUGIN] Request received', { userId: auth.userId, orgId: auth.orgId, pluginId: id });

  try {
    const plugin = await pluginService.getPluginById(auth.orgId, id, {
      userId: auth.userId,
      token: auth.token,
    });

    logger.info('[GET PLUGIN] Success', {
      userId: auth.userId,
      orgId: auth.orgId,
      pluginId: id,
      pluginName: plugin.name,
    });

    sendSuccess(res, 200, plugin);
  } catch (err) {
    logger.error('[GET PLUGIN] Failed:', err);
    handleError(res, err, 'get plugin');
  }
}

/**
 * Get a single plugin by query filters
 * GET /plugin/search
 */
export async function getPlugin(req: Request, res: Response): Promise<void> {
  const auth = getAuthContext(req, res, 'view plugins');
  if (!auth) return;

  const filter = buildFilter(req.query, { includeId: true });

  if (Object.keys(filter).length === 0) {
    return sendError(res, 400, 'At least one search filter is required');
  }

  logger.info('[GET PLUGIN] Search request received', { userId: auth.userId, orgId: auth.orgId, filter });

  try {
    const plugin = await pluginService.getPlugin(auth.orgId, filter, {
      userId: auth.userId,
      token: auth.token,
    });

    logger.info('[GET PLUGIN] Search success', {
      userId: auth.userId,
      orgId: auth.orgId,
      pluginId: plugin.id,
      pluginName: plugin.name,
    });

    sendSuccess(res, 200, plugin);
  } catch (err) {
    logger.error('[GET PLUGIN] Search failed:', err);
    handleError(res, err, 'get plugin');
  }
}

/**
 * Upload and create a new plugin
 * POST /plugin
 */
export async function createPlugin(req: Request, res: Response): Promise<void> {
  const auth = getAuthContext(req, res, 'upload plugins');
  if (!auth) return;

  const file = req.file;
  if (!file) {
    return sendError(res, 400, 'Plugin file is required');
  }

  if (!file.originalname.endsWith('.zip')) {
    return sendError(res, 400, 'Plugin must be a ZIP file');
  }

  const accessModifier = req.body.accessModifier === 'public' ? 'public' : 'private';

  logger.info('[CREATE PLUGIN] Upload request received', {
    userId: auth.userId,
    orgId: auth.orgId,
    filename: file.originalname,
    size: file.size,
    accessModifier,
  });

  try {
    const result = await pluginService.uploadPlugin(
      auth.orgId,
      { file: file.buffer, filename: file.originalname, accessModifier },
      { userId: auth.userId, token: auth.token },
    );

    logger.info('[CREATE PLUGIN] Upload success', {
      userId: auth.userId,
      orgId: auth.orgId,
      pluginId: result.id,
      pluginName: result.name,
      version: result.version,
    });

    res.status(201).json({
      success: true,
      statusCode: 201,
      message: result.message,
      plugin: {
        id: result.id,
        name: result.name,
        version: result.version,
        imageTag: result.imageTag,
        fullImage: result.fullImage,
        accessModifier: result.accessModifier,
        isDefault: result.isDefault,
        isActive: result.isActive,
        createdBy: result.createdBy,
      },
    });
  } catch (err) {
    logger.error('[CREATE PLUGIN] Upload failed:', err);
    handleError(res, err, 'upload plugin');
  }
}