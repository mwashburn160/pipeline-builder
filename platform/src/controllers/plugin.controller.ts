import { Request, Response } from 'express';
import {
  logger,
  sendError,
  sendSuccess,
  sendCreated,
  pluginService,
  PluginServiceError,
  PluginFilter,
  ErrorCode,
  HttpStatus,
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
 * Check if user is system admin
 */
function isSystemAdmin(req: Request): boolean {
  if (req.user?.role !== 'admin') return false;
  const orgId = req.user?.organizationId?.toLowerCase();
  const orgName = req.user?.organizationName?.toLowerCase();
  return orgId === 'system' || orgName === 'system';
}

/**
 * Check if user is organization admin (admin role in any non-system org)
 */
function isOrgAdmin(req: Request): boolean {
  return req.user?.role === 'admin' && !isSystemAdmin(req);
}

/**
 * Check if user can set public access modifier
 * Only system admins and organization admins can set public access
 * Regular users can only set private access
 */
function canSetPublicAccess(req: Request): boolean {
  return isSystemAdmin(req) || isOrgAdmin(req);
}

/**
 * Validate and normalize access modifier based on user permissions
 * Returns the allowed access modifier or null if validation fails
 */
function validateAccessModifier(
  req: Request,
  requestedModifier?: string,
): { accessModifier: 'public' | 'private'; wasOverridden: boolean } {
  const isAdmin = canSetPublicAccess(req);
  const wantsPublic = requestedModifier === 'public';

  // If user wants public but doesn't have permission, override to private
  if (wantsPublic && !isAdmin) {
    return { accessModifier: 'private', wasOverridden: true };
  }

  // Valid public request from admin
  if (wantsPublic && isAdmin) {
    return { accessModifier: 'public', wasOverridden: false };
  }

  // Default to private
  return { accessModifier: 'private', wasOverridden: false };
}

/**
 * List plugins with optional filters
 * GET /plugin
 * Query params: name, version, pluginType, computeType, isActive, isDefault, accessModifier, page, limit
 */
export async function listPlugins(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization to list plugins', ErrorCode.INVALID_INPUT);
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication token is required', ErrorCode.UNAUTHORIZED);
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

    sendSuccess(res, {
      plugins: result.plugins,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: Math.ceil(result.total / result.limit),
    });
  } catch (err) {
    logger.error('[LIST PLUGINS] Failed:', err);

    if (err instanceof PluginServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to list plugins', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Get a single plugin by ID
 * GET /plugin/:id
 */
export async function getPluginById(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization to view plugins', ErrorCode.INVALID_INPUT);
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication token is required', ErrorCode.UNAUTHORIZED);
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Plugin ID is required', ErrorCode.MISSING_FIELDS);
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

    sendSuccess(res, { plugin });
  } catch (err) {
    logger.error('[GET PLUGIN] Failed:', err);

    if (err instanceof PluginServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to get plugin', ErrorCode.INTERNAL_ERROR);
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
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization to view plugins', ErrorCode.INVALID_INPUT);
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication token is required', ErrorCode.UNAUTHORIZED);
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
      return sendError(res, HttpStatus.BAD_REQUEST, 'At least one search filter is required', ErrorCode.MISSING_FIELDS);
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

    sendSuccess(res, { plugin });
  } catch (err) {
    logger.error('[GET PLUGIN] Search failed:', err);

    if (err instanceof PluginServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to get plugin', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Upload and create a new plugin
 * POST /plugin
 * Body: multipart/form-data with 'plugin' file and optional 'accessModifier'
 *
 * Access Modifier Permissions:
 * - System Admin: can set 'public' or 'private'
 * - Organization Admin: can set 'public' or 'private'
 * - Regular User: can only set 'private' (public requests are automatically converted to private)
 */
export async function createPlugin(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization to upload plugins', ErrorCode.INVALID_INPUT);
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication token is required', ErrorCode.UNAUTHORIZED);
    }

    // Check for uploaded file
    const file = req.file;
    if (!file) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Plugin file is required', ErrorCode.MISSING_FIELDS);
    }

    // Validate file type
    if (!file.originalname.endsWith('.zip')) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Plugin must be a ZIP file', ErrorCode.INVALID_FORMAT);
    }

    // Validate and normalize access modifier based on user permissions
    const requestedModifier = req.body.accessModifier;
    const { accessModifier, wasOverridden } = validateAccessModifier(req, requestedModifier);

    // Log if access modifier was overridden due to insufficient permissions
    if (wasOverridden) {
      logger.warn('[CREATE PLUGIN] Access modifier overridden to private - user lacks admin permissions', {
        userId: req.user.sub,
        orgId,
        userRole: req.user.role,
        requestedModifier,
        actualModifier: accessModifier,
      });
    }

    logger.info('[CREATE PLUGIN] Upload request received', {
      userId: req.user.sub,
      orgId,
      userRole: req.user.role,
      isSystemAdmin: isSystemAdmin(req),
      isOrgAdmin: isOrgAdmin(req),
      filename: file.originalname,
      size: file.size,
      requestedAccessModifier: requestedModifier,
      effectiveAccessModifier: accessModifier,
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
      accessModifier: result.accessModifier,
    });

    // Include warning in response if access modifier was overridden
    const responseData: Record<string, unknown> = {
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
    };

    if (wasOverridden) {
      responseData.warning = 'Access modifier was set to private. Only administrators can create public plugins.';
    }

    sendCreated(res, responseData, result.message || 'Plugin uploaded successfully');
  } catch (err) {
    logger.error('[CREATE PLUGIN] Upload failed:', err);

    if (err instanceof PluginServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to upload plugin', ErrorCode.INTERNAL_ERROR);
  }
}
