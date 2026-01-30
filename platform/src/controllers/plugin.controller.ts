import { Request, Response } from 'express';
import {
  logger,
  sendError,
  sendSuccess,
  pluginService,
  PluginServiceError,
  PluginFilter,
} from '../utils';

/**
 * Extract JWT token from Authorization header
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return null;
  }
  // Handle case where header could be string or string[]
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  return header.split(' ')[1];
}

/**
 * List plugins with optional filters
 * GET /plugin
 * Query params: name, version, pluginType, computeType, isActive, isDefault, accessModifier, page, limit
 */
export async function listPlugins(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, 400, 'You must belong to an organization to list plugins');
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, 401, 'Authentication token is required');
    }

    // Build filter from query params
    const filter: PluginFilter = {};

    if (req.query.name) filter.name = String(req.query.name);
    if (req.query.version) filter.version = String(req.query.version);
    if (req.query.pluginType) filter.pluginType = String(req.query.pluginType);
    if (req.query.computeType) filter.computeType = String(req.query.computeType);
    if (req.query.accessModifier) {
      const am = String(req.query.accessModifier);
      if (am === 'public' || am === 'private') {
        filter.accessModifier = am;
      }
    }
    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }
    if (req.query.isDefault !== undefined) {
      filter.isDefault = req.query.isDefault === 'true';
    }
    if (req.query.page) {
      filter.page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    }
    if (req.query.limit) {
      filter.limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    }

    logger.info('[LIST PLUGINS] Request received', {
      userId: req.user.sub,
      orgId,
      filter,
    });

    const result = await pluginService.listPlugins(orgId, filter, {
      userId: req.user.sub,
      token,
    });

    logger.info('[LIST PLUGINS] Success', {
      userId: req.user.sub,
      orgId,
      count: result.plugins.length,
      total: result.total,
    });

    res.json({
      success: true,
      statusCode: 200,
      ...result,
    });
  } catch (err) {
    logger.error('[LIST PLUGINS] Failed:', err);

    if (err instanceof PluginServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, 500, 'Failed to list plugins');
  }
}

/**
 * Get a single plugin by ID
 * GET /plugin/:id
 */
export async function getPluginById(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, 400, 'You must belong to an organization to view plugins');
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, 401, 'Authentication token is required');
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      return sendError(res, 400, 'Plugin ID is required');
    }

    logger.info('[GET PLUGIN] Request received', {
      userId: req.user.sub,
      orgId,
      pluginId: id,
    });

    const plugin = await pluginService.getPluginById(orgId, id, {
      userId: req.user.sub,
      token,
    });

    logger.info('[GET PLUGIN] Success', {
      userId: req.user.sub,
      orgId,
      pluginId: id,
      pluginName: plugin.name,
    });

    sendSuccess(res, plugin);
  } catch (err) {
    logger.error('[GET PLUGIN] Failed:', err);

    if (err instanceof PluginServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, 500, 'Failed to get plugin');
  }
}

/**
 * Get a single plugin by query filters
 * GET /plugin/search
 * Query params: name, version, pluginType, etc.
 */
export async function getPlugin(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, 400, 'You must belong to an organization to view plugins');
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, 401, 'Authentication token is required');
    }

    // Build filter from query params
    const filter: PluginFilter = {};

    if (req.query.id) filter.id = String(req.query.id);
    if (req.query.name) filter.name = String(req.query.name);
    if (req.query.version) filter.version = String(req.query.version);
    if (req.query.pluginType) filter.pluginType = String(req.query.pluginType);
    if (req.query.computeType) filter.computeType = String(req.query.computeType);
    if (req.query.accessModifier) {
      const am = String(req.query.accessModifier);
      if (am === 'public' || am === 'private') {
        filter.accessModifier = am;
      }
    }
    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }
    if (req.query.isDefault !== undefined) {
      filter.isDefault = req.query.isDefault === 'true';
    }

    // Require at least one filter
    if (Object.keys(filter).length === 0) {
      return sendError(res, 400, 'At least one search filter is required');
    }

    logger.info('[GET PLUGIN] Search request received', {
      userId: req.user.sub,
      orgId,
      filter,
    });

    const plugin = await pluginService.getPlugin(orgId, filter, {
      userId: req.user.sub,
      token,
    });

    logger.info('[GET PLUGIN] Search success', {
      userId: req.user.sub,
      orgId,
      pluginId: plugin.id,
      pluginName: plugin.name,
    });

    sendSuccess(res, plugin);
  } catch (err) {
    logger.error('[GET PLUGIN] Search failed:', err);

    if (err instanceof PluginServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, 500, 'Failed to get plugin');
  }
}

/**
 * Upload and create a new plugin
 * POST /plugin
 * Body: multipart/form-data with 'plugin' file and optional 'accessModifier'
 */
export async function createPlugin(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, 400, 'You must belong to an organization to upload plugins');
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, 401, 'Authentication token is required');
    }

    // Check for uploaded file
    const file = req.file;
    if (!file) {
      return sendError(res, 400, 'Plugin file is required');
    }

    // Validate file type
    if (!file.originalname.endsWith('.zip')) {
      return sendError(res, 400, 'Plugin must be a ZIP file');
    }

    // Get access modifier from body
    const accessModifier = req.body.accessModifier === 'public' ? 'public' : 'private';

    logger.info('[CREATE PLUGIN] Upload request received', {
      userId: req.user.sub,
      orgId,
      filename: file.originalname,
      size: file.size,
      accessModifier,
    });

    const result = await pluginService.uploadPlugin(
      orgId,
      {
        file: file.buffer,
        filename: file.originalname,
        accessModifier,
      },
      {
        userId: req.user.sub,
        token,
      },
    );

    logger.info('[CREATE PLUGIN] Upload success', {
      userId: req.user.sub,
      orgId,
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

    if (err instanceof PluginServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, 500, 'Failed to upload plugin');
  }
}
