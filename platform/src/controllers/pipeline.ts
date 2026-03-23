import { createLogger, sendError, sendSuccess } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import { getAuthContext, handleControllerError } from '../helpers/controller-helper';
import {
  pipelineService,
  PipelineServiceError,
  PipelineFilter,
} from '../services';
import { parsePagination } from '../utils/pagination';

const logger = createLogger('PipelineController');

/** Replace non-alphanumeric characters in a string. */
function replaceNonAlphanumeric(input: string, replaceValue: string = '_'): string {
  return input.replace(/[^a-zA-Z0-9]/g, replaceValue);
}

/** Build pipeline filter from request query parameters. */
function buildFilter(query: Request['query'], options?: { includeId?: boolean; includePagination?: boolean }): PipelineFilter {
  const filter: PipelineFilter = {};

  if (options?.includeId && query.id) filter.id = String(query.id);
  if (query.project) filter.project = String(query.project);
  if (query.organization) filter.organization = String(query.organization);
  if (query.pipelineName) filter.pipelineName = String(query.pipelineName);

  const am = String(query.accessModifier ?? '');
  if (am === 'public' || am === 'private') filter.accessModifier = am;

  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (query.isDefault !== undefined) filter.isDefault = query.isDefault === 'true';

  if (options?.includePagination && (query.page || query.limit)) {
    const pg = parsePagination(query.page, query.limit);
    filter.page = pg.page;
    filter.limit = pg.limit;
  }

  return filter;
}

/** Map caught errors to HTTP responses. */
function handleError(res: Response, err: unknown, operation: string): void {
  if (err instanceof PipelineServiceError) {
    sendError(res, err.statusCode, err.message, err.code);
  } else {
    handleControllerError(res, err, `Failed to ${operation}`);
  }
}

/**
 * List pipelines with optional filters
 * GET /pipeline
 */
export async function listPipelines(req: Request, res: Response): Promise<void> {
  const auth = getAuthContext(req, res, 'list pipelines');
  if (!auth) return;

  try {
    const filter = buildFilter(req.query, { includePagination: true });
    const result = await pipelineService.listPipelines(auth.orgId, filter, auth);

    logger.info('[LIST PIPELINES] Success', { userId: auth.userId, orgId: auth.orgId, count: result.pipelines.length });
    sendSuccess(res, 200, result);
  } catch (err) {
    handleError(res, err, 'list pipelines');
  }
}

/**
 * Get a single pipeline by ID
 * GET /pipeline/:id
 */
export async function getPipelineById(req: Request, res: Response): Promise<void> {
  const auth = getAuthContext(req, res, 'view pipelines');
  if (!auth) return;

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id) return sendError(res, 400, 'Pipeline ID is required');

  try {
    const pipeline = await pipelineService.getPipelineById(auth.orgId, id, auth);
    sendSuccess(res, 200, pipeline);
  } catch (err) {
    handleError(res, err, 'get pipeline');
  }
}

/**
 * Get a single pipeline by query filters
 * GET /pipeline/search
 */
export async function getPipeline(req: Request, res: Response): Promise<void> {
  const auth = getAuthContext(req, res, 'view pipelines');
  if (!auth) return;

  const filter = buildFilter(req.query, { includeId: true });
  if (Object.keys(filter).length === 0) {
    return sendError(res, 400, 'At least one search filter is required');
  }

  try {
    const pipeline = await pipelineService.getPipeline(auth.orgId, filter, auth);
    sendSuccess(res, 200, pipeline);
  } catch (err) {
    handleError(res, err, 'get pipeline');
  }
}

/**
 * Create a new pipeline configuration
 * POST /pipeline
 */
export async function createPipeline(req: Request, res: Response): Promise<void> {
  const auth = getAuthContext(req, res, 'create pipelines');
  if (!auth) return;

  const { project, organization, pipelineName, props, accessModifier } = req.body;

  if (!project || typeof project !== 'string') {
    return sendError(res, 400, 'project is required and must be a string');
  }
  if (!organization || typeof organization !== 'string') {
    return sendError(res, 400, 'organization is required and must be a string');
  }
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return sendError(res, 400, 'Pipeline props (builderProps) are required and must be an object');
  }
  if (!props.synth || typeof props.synth !== 'object') {
    return sendError(res, 400, 'Pipeline props must include a synth configuration');
  }

  const resolvedProject = replaceNonAlphanumeric(project, '_');
  const resolvedOrganization = replaceNonAlphanumeric(organization, '_');
  const resolvedPipelineName: string = pipelineName
    ?? `${resolvedOrganization.toLowerCase()}-${resolvedProject.toLowerCase()}-pipeline`;
  const validAccessModifier = accessModifier === 'public' ? 'public' : 'private';

  try {
    const result = await pipelineService.createPipeline(
      auth.orgId,
      {
        project: resolvedProject,
        organization: resolvedOrganization,
        pipelineName: resolvedPipelineName,
        props,
        accessModifier: validAccessModifier,
      },
      auth,
    );

    logger.info('[CREATE PIPELINE] Success', { userId: auth.userId, orgId: auth.orgId, pipelineId: result.id });
    sendSuccess(res, 201, {
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
    }, result.message);
  } catch (err) {
    handleError(res, err, 'create pipeline');
  }
}
