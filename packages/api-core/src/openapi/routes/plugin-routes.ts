import { addRegistration, registry } from '../registry';

const tags = ['Plugins'];
const auth = [{ bearerAuth: [] }];

addRegistration(() => {
  registry.registerPath({
    method: 'get',
    path: '/plugins',
    summary: 'List plugins',
    description: 'List plugins with pagination, filtering, and sorting.',
    tags,
    security: auth,
    responses: { 200: { description: 'Paginated list of plugins' }, 401: { description: 'Unauthorized' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/plugins/find',
    summary: 'Find a single plugin',
    description: 'Find a single plugin matching the query filters.',
    tags,
    security: auth,
    responses: { 200: { description: 'Plugin found' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/plugins/{id}',
    summary: 'Get plugin by ID',
    tags,
    security: auth,
    responses: { 200: { description: 'Plugin details' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins',
    summary: 'Upload a plugin',
    description: 'Upload a plugin ZIP file with manifest. Builds Docker image and saves to database.',
    tags,
    security: auth,
    responses: { 202: { description: 'Plugin build queued' }, 400: { description: 'Validation error' }, 429: { description: 'Quota exceeded' } },
  });

  registry.registerPath({
    method: 'put',
    path: '/plugins/{id}',
    summary: 'Update a plugin',
    tags,
    security: auth,
    responses: { 200: { description: 'Plugin updated' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'delete',
    path: '/plugins/{id}',
    summary: 'Delete a plugin',
    description: 'Soft-delete a plugin by setting isActive to false.',
    tags,
    security: auth,
    responses: { 200: { description: 'Plugin deleted' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/plugins/providers',
    summary: 'List AI providers',
    description: 'List AI providers configured for plugin generation.',
    tags,
    security: auth,
    responses: { 200: { description: 'List of available AI providers with models' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/generate',
    summary: 'Generate plugin via AI',
    description: 'Generate a plugin configuration and Dockerfile from a natural language prompt.',
    tags,
    security: auth,
    responses: { 200: { description: 'Generated plugin configuration and Dockerfile' }, 400: { description: 'Validation error' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/generate/stream',
    summary: 'Stream plugin generation via AI',
    description: 'Generate plugin configuration from a natural language prompt. Streams partial results as SSE events.',
    tags,
    security: auth,
    responses: { 200: { description: 'SSE event stream of partial plugin objects' }, 400: { description: 'Validation error' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/deploy-generated',
    summary: 'Deploy AI-generated plugin',
    description: 'Build Docker image from AI-generated Dockerfile and save plugin to database. Requires admin.',
    tags,
    security: auth,
    responses: { 202: { description: 'Plugin build queued' }, 400: { description: 'Validation error' }, 403: { description: 'Admin required' }, 429: { description: 'Quota exceeded' } },
  });
});
