/**
 * @module openapi/routes/pipeline-routes
 * @description OpenAPI route specs for the Pipeline service.
 */

import { addRegistration, registry } from '../registry';

const tags = ['Pipelines'];
const auth = [{ bearerAuth: [] }];

addRegistration(() => {
  registry.registerPath({
    method: 'get',
    path: '/pipelines',
    summary: 'List pipelines',
    description: 'List pipelines with pagination, filtering, and sorting.',
    tags,
    security: auth,
    responses: { 200: { description: 'Paginated list of pipelines' }, 401: { description: 'Unauthorized' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/pipelines/find',
    summary: 'Find a single pipeline',
    description: 'Find a single pipeline matching the query filters.',
    tags,
    security: auth,
    responses: { 200: { description: 'Pipeline found' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/pipelines/{id}',
    summary: 'Get pipeline by ID',
    tags,
    security: auth,
    responses: { 200: { description: 'Pipeline details' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/pipelines',
    summary: 'Create a pipeline',
    description: 'Create a new pipeline configuration. Checks pipeline quota.',
    tags,
    security: auth,
    responses: { 201: { description: 'Pipeline created' }, 400: { description: 'Validation error' }, 429: { description: 'Quota exceeded' } },
  });

  registry.registerPath({
    method: 'put',
    path: '/pipelines/{id}',
    summary: 'Update a pipeline',
    tags,
    security: auth,
    responses: { 200: { description: 'Pipeline updated' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'delete',
    path: '/pipelines/{id}',
    summary: 'Delete a pipeline',
    description: 'Soft-delete a pipeline by setting isActive to false.',
    tags,
    security: auth,
    responses: { 200: { description: 'Pipeline deleted' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/pipelines/providers',
    summary: 'List AI providers',
    description: 'List AI providers configured for pipeline generation.',
    tags,
    security: auth,
    responses: { 200: { description: 'List of available AI providers with models' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/pipelines/generate',
    summary: 'Generate pipeline via AI',
    description: 'Generate a BuilderProps configuration from a natural language prompt. Returns the complete result when done.',
    tags,
    security: auth,
    responses: { 200: { description: 'Generated pipeline configuration' }, 400: { description: 'Validation error' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/pipelines/generate/stream',
    summary: 'Stream pipeline generation via AI',
    description: 'Generate a BuilderProps configuration from a natural language prompt. Streams partial results as SSE events.',
    tags,
    security: auth,
    responses: { 200: { description: 'SSE event stream of partial pipeline objects' }, 400: { description: 'Validation error' } },
  });
});
