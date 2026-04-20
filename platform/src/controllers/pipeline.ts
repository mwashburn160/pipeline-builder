// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { Request } from 'express';
import { getAuthContext, withController } from '../helpers/controller-helper';
import {
  pipelineService,
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

  if (options?.includePagination && (query.offset || query.limit)) {
    const pg = parsePagination(query.offset, query.limit);
    filter.offset = pg.offset;
    filter.limit = pg.limit;
  }

  return filter;
}


/**
 * List pipelines with optional filters
 * GET /pipeline
 */
export const listPipelines = withController('List pipelines', async (req, res) => {
  const auth = getAuthContext(req, res, 'list pipelines');
  if (!auth) return;

  const filter = buildFilter(req.query, { includePagination: true });
  const result = await pipelineService.listPipelines(auth.orgId, filter, auth);

  logger.info('[LIST PIPELINES] Success', { userId: auth.userId, orgId: auth.orgId, count: result.pipelines.length });
  sendSuccess(res, 200, result);
});

/**
 * Get a single pipeline by ID
 * GET /pipeline/:id
 */
export const getPipelineById = withController('Get pipeline', async (req, res) => {
  const auth = getAuthContext(req, res, 'view pipelines');
  if (!auth) return;

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id) return sendError(res, 400, 'Pipeline ID is required');

  const pipeline = await pipelineService.getPipelineById(auth.orgId, id, auth);
  sendSuccess(res, 200, pipeline);
});

/**
 * Get a single pipeline by query filters
 * GET /pipeline/search
 */
export const getPipeline = withController('Search pipeline', async (req, res) => {
  const auth = getAuthContext(req, res, 'view pipelines');
  if (!auth) return;

  const filter = buildFilter(req.query, { includeId: true });
  if (Object.keys(filter).length === 0) {
    return sendError(res, 400, 'At least one search filter is required');
  }

  const pipeline = await pipelineService.getPipeline(auth.orgId, filter, auth);
  sendSuccess(res, 200, pipeline);
});

/**
 * Create a new pipeline configuration
 * POST /pipeline
 */
export const createPipeline = withController('Create pipeline', async (req, res) => {
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
});
