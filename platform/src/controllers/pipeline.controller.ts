import { createLogger, sendError, sendSuccess } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import { extractToken } from '../helpers/controller-helper';
import {
  pipelineService,
  PipelineServiceError,
  PipelineFilter,
} from '../services';

const logger = createLogger('PipelineController');

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
  } catch (error) {
    logger.error('[LIST PIPELINES] Failed:', error);

    if (error instanceof PipelineServiceError) {
      return sendError(res, error.statusCode, error.message, error.code);
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

    sendSuccess(res, 200, pipeline);
  } catch (error) {
    logger.error('[GET PIPELINE] Failed:', error);

    if (error instanceof PipelineServiceError) {
      return sendError(res, error.statusCode, error.message, error.code);
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

    sendSuccess(res, 200, pipeline);
  } catch (error) {
    logger.error('[GET PIPELINE] Search failed:', error);

    if (error instanceof PipelineServiceError) {
      return sendError(res, error.statusCode, error.message, error.code);
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

    if (!project || typeof project !== 'string') {
      return sendError(res, 400, 'project is required and must be a string');
    }
    if (!organization || typeof organization !== 'string') {
      return sendError(res, 400, 'organization is required and must be a string');
    }
    if (!props || typeof props !== 'object') {
      return sendError(res, 400, 'Pipeline props (builderProps) are required');
    }

    const resolvedProject = project;
    const resolvedOrganization = organization;
    const builderProps = props;

    const resolvedPipelineName: string = pipelineName
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
  } catch (error) {
    logger.error('[CREATE PIPELINE] Failed:', error);

    if (error instanceof PipelineServiceError) {
      return sendError(res, error.statusCode, error.message, error.code);
    }

    return sendError(res, 500, 'Failed to create pipeline');
  }
}

function replaceNonAlphanumeric(input: string, replaceValue: string = '_'): string {
  return input.replace(/[^a-zA-Z0-9]/g, replaceValue);
}