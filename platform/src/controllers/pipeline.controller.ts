import { Request, Response } from 'express';
import {
  logger,
  sendError,
  sendSuccess,
  sendCreated,
  pipelineService,
  PipelineServiceError,
  PipelineFilter,
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
 * Check if user can set public access modifier for pipelines
 * Only system admins can set public access for pipelines
 * Organization admins and regular users can only set private access
 */
function canSetPublicAccess(req: Request): boolean {
  return isSystemAdmin(req);
}

/**
 * Validate and normalize access modifier based on user permissions
 * Returns the allowed access modifier and whether it was overridden
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
 * List pipelines with optional filters
 * GET /pipeline
 * Query params: project, organization, pipelineName, isActive, isDefault, accessModifier, page, limit
 */
export async function listPipelines(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization to list pipelines', ErrorCode.INVALID_INPUT);
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication token is required', ErrorCode.UNAUTHORIZED);
    }

    // Build filter from query params
    const filter: PipelineFilter = {};

    if (req.query.project) filter.project = String(req.query.project);
    if (req.query.organization) filter.organization = String(req.query.organization);
    if (req.query.pipelineName) filter.pipelineName = String(req.query.pipelineName);
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

    logger.info('[LIST PIPELINES] Request received', {
      userId: req.user.sub,
      orgId,
      filter,
    });

    const result = await pipelineService.listPipelines(orgId, filter, {
      userId: req.user.sub,
      token,
    });

    logger.info('[LIST PIPELINES] Success', {
      userId: req.user.sub,
      orgId,
      count: result.pipelines.length,
      total: result.total,
    });

    sendSuccess(res, {
      pipelines: result.pipelines,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: Math.ceil(result.total / result.limit),
    });
  } catch (err) {
    logger.error('[LIST PIPELINES] Failed:', err);

    if (err instanceof PipelineServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to list pipelines', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Get a single pipeline by ID
 * GET /pipeline/:id
 */
export async function getPipelineById(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization to view pipelines', ErrorCode.INVALID_INPUT);
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication token is required', ErrorCode.UNAUTHORIZED);
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Pipeline ID is required', ErrorCode.MISSING_FIELDS);
    }

    logger.info('[GET PIPELINE] Request received', {
      userId: req.user.sub,
      orgId,
      pipelineId: id,
    });

    const pipeline = await pipelineService.getPipelineById(orgId, id, {
      userId: req.user.sub,
      token,
    });

    logger.info('[GET PIPELINE] Success', {
      userId: req.user.sub,
      orgId,
      pipelineId: id,
      project: pipeline.project,
    });

    sendSuccess(res, { pipeline });
  } catch (err) {
    logger.error('[GET PIPELINE] Failed:', err);

    if (err instanceof PipelineServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to get pipeline', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Get a single pipeline by query filters
 * GET /pipeline/search
 * Query params: project, organization, pipelineName, etc.
 */
export async function getPipeline(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization to view pipelines', ErrorCode.INVALID_INPUT);
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication token is required', ErrorCode.UNAUTHORIZED);
    }

    // Build filter from query params
    const filter: PipelineFilter = {};

    if (req.query.id) filter.id = String(req.query.id);
    if (req.query.project) filter.project = String(req.query.project);
    if (req.query.organization) filter.organization = String(req.query.organization);
    if (req.query.pipelineName) filter.pipelineName = String(req.query.pipelineName);
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

    logger.info('[GET PIPELINE] Search request received', {
      userId: req.user.sub,
      orgId,
      filter,
    });

    const pipeline = await pipelineService.getPipeline(orgId, filter, {
      userId: req.user.sub,
      token,
    });

    logger.info('[GET PIPELINE] Search success', {
      userId: req.user.sub,
      orgId,
      pipelineId: pipeline.id,
      project: pipeline.project,
    });

    sendSuccess(res, { pipeline });
  } catch (err) {
    logger.error('[GET PIPELINE] Search failed:', err);

    if (err instanceof PipelineServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to get pipeline', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Create a new pipeline configuration
 * POST /pipeline
 * Body: { project, organization, props, accessModifier? }
 *
 * Access Modifier Permissions:
 * - System Admin: can set 'public' or 'private'
 * - Organization Admin: can only set 'private' (public requests are automatically converted to private)
 * - Regular User: can only set 'private' (public requests are automatically converted to private)
 */
export async function createPipeline(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization to create pipelines', ErrorCode.INVALID_INPUT);
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication token is required', ErrorCode.UNAUTHORIZED);
    }

    const { project, organization, props, accessModifier: requestedModifier } = req.body;

    // Validate required fields
    if (!project || typeof project !== 'string') {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Project name is required', ErrorCode.MISSING_FIELDS);
    }

    if (!organization || typeof organization !== 'string') {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Organization name is required', ErrorCode.MISSING_FIELDS);
    }

    if (!props || typeof props !== 'object') {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Pipeline props are required', ErrorCode.MISSING_FIELDS);
    }

    // Validate and normalize access modifier based on user permissions
    const { accessModifier, wasOverridden } = validateAccessModifier(req, requestedModifier);

    // Log if access modifier was overridden due to insufficient permissions
    if (wasOverridden) {
      logger.warn('[CREATE PIPELINE] Access modifier overridden to private - user lacks admin permissions', {
        userId: req.user.sub,
        orgId,
        userRole: req.user.role,
        requestedModifier,
        actualModifier: accessModifier,
      });
    }

    logger.info('[CREATE PIPELINE] Request received', {
      userId: req.user.sub,
      orgId,
      userRole: req.user.role,
      isSystemAdmin: isSystemAdmin(req),
      isOrgAdmin: isOrgAdmin(req),
      project,
      organization,
      requestedAccessModifier: requestedModifier,
      effectiveAccessModifier: accessModifier,
    });

    const result = await pipelineService.createPipeline(
      orgId,
      {
        project,
        organization,
        props,
        accessModifier,
      },
      {
        userId: req.user.sub,
        token,
      },
    );

    logger.info('[CREATE PIPELINE] Success', {
      userId: req.user.sub,
      orgId,
      pipelineId: result.id,
      project: result.project,
      organization: result.organization,
      accessModifier: result.accessModifier,
    });

    // Include warning in response if access modifier was overridden
    const responseData: Record<string, unknown> = {
      pipeline: {
        id: result.id,
        project: result.project,
        organization: result.organization,
        pipelineName: result.pipelineName,
        accessModifier: result.accessModifier,
        isDefault: result.isDefault,
        isActive: result.isActive,
        createdAt: result.createdAt,
        createdBy: result.createdBy,
      },
    };

    if (wasOverridden) {
      responseData.warning = 'Access modifier was set to private. Only system administrators can create public pipelines.';
    }

    sendCreated(res, responseData, result.message || 'Pipeline created successfully');
  } catch (err) {
    logger.error('[CREATE PIPELINE] Failed:', err);

    if (err instanceof PipelineServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to create pipeline', ErrorCode.INTERNAL_ERROR);
  }
}
