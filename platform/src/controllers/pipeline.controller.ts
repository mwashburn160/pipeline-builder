import { Request, Response } from 'express';
import {
  logger,
  sendError,
  sendSuccess,
  pipelineService,
  PipelineServiceError,
  PipelineFilter,
} from '../utils';
import { extractToken } from './helpers';

/**
 * List pipelines with optional filters
 * GET /pipeline
 * Query params: project, organization, pipelineName, isActive, isDefault, accessModifier, page, limit
 */
export async function listPipelines(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, 400, 'You must belong to an organization to list pipelines');
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, 401, 'Authentication token is required');
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

    res.json({
      success: true,
      statusCode: 200,
      ...result,
    });
  } catch (err) {
    logger.error('[LIST PIPELINES] Failed:', err);

    if (err instanceof PipelineServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, 500, 'Failed to list pipelines');
  }
}

/**
 * Get a single pipeline by ID
 * GET /pipeline/:id
 */
export async function getPipelineById(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, 400, 'You must belong to an organization to view pipelines');
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, 401, 'Authentication token is required');
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      return sendError(res, 400, 'Pipeline ID is required');
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

    sendSuccess(res, pipeline);
  } catch (err) {
    logger.error('[GET PIPELINE] Failed:', err);

    if (err instanceof PipelineServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, 500, 'Failed to get pipeline');
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
      return sendError(res, 401, 'Unauthorized');
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, 400, 'You must belong to an organization to view pipelines');
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, 401, 'Authentication token is required');
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
      return sendError(res, 400, 'At least one search filter is required');
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

    sendSuccess(res, pipeline);
  } catch (err) {
    logger.error('[GET PIPELINE] Search failed:', err);

    if (err instanceof PipelineServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, 500, 'Failed to get pipeline');
  }
}

/**
 * Create a new pipeline configuration
 * POST /pipeline
 * Body: { pipelineName?, props, accessModifier  }
 */
export async function createPipeline(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, 400, 'You must belong to an organization to create pipelines');
    }

    const token = extractToken(req);
    if (!token) {
      return sendError(res, 401, 'Authentication token is required');
    }

    const { project, organization, pipelineName, props, accessModifier } = req.body;

    if (!props || typeof props !== 'object') {
      return sendError(res, 400, 'Pipeline props (builderProps) are required');
    }

    // Resolve project & organization: prefer top-level fields from the CLI,
    // fall back to values inside props for backward compatibility.
    const resolvedProject: string | undefined = project ?? props.project;
    const resolvedOrganization: string | undefined = organization ?? props.organization;

    if (!resolvedProject || typeof resolvedProject !== 'string') {
      return sendError(res, 400, 'project is required and must be a string');
    }
    if (!resolvedOrganization || typeof resolvedOrganization !== 'string') {
      return sendError(res, 400, 'organization is required and must be a string');
    }

    // Extract the actual BuilderProps to store.
    // If props contains a nested "props" key with a "synth" object, the caller
    // sent the full pipeline payload as the props file — unwrap one level.
    const builderProps =
      props.props && typeof props.props === 'object' && (props.props as Record<string, unknown>).synth
        ? props.props
        : props;

    // Resolve pipelineName: prefer top-level, fall back to builderProps, then default.
    const resolvedPipelineName: string = pipelineName
      ?? builderProps.pipelineName
      ?? `${replaceNonAlphanumeric(resolvedOrganization).toLowerCase()}-${replaceNonAlphanumeric(resolvedProject).toLowerCase()}-pipeline`;

    // Validate access modifier
    const validAccessModifier = accessModifier === 'public' ? 'public' : 'private';

    logger.info('[CREATE PIPELINE] Request received', {
      userId: req.user.sub,
      orgId,
      pipelineName: resolvedPipelineName,
      project: replaceNonAlphanumeric(resolvedProject),
      organization: replaceNonAlphanumeric(resolvedOrganization),
      accessModifier: validAccessModifier,
    });

    const result = await pipelineService.createPipeline(
      orgId,
      {
        project: replaceNonAlphanumeric(resolvedProject),
        organization: replaceNonAlphanumeric(resolvedOrganization),
        pipelineName: resolvedPipelineName,
        props: builderProps,
        accessModifier: validAccessModifier,
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
    });

    res.status(201).json({
      success: true,
      statusCode: 201,
      message: result.message,
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
    });
  } catch (err) {
    logger.error('[CREATE PIPELINE] Failed:', err);

    if (err instanceof PipelineServiceError) {
      return sendError(res, err.statusCode, err.message, err.code);
    }

    return sendError(res, 500, 'Failed to create pipeline');
  }
}

function replaceNonAlphanumeric(input: string, replaceValue: string = '_'): string {
  return input.replace(/[^a-zA-Z0-9]/g, replaceValue);
}