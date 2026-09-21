// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registry } from '../registry.js';

const tags = ['Plugins'];
const auth = [{ bearerAuth: [] }];

export function registerPluginRoutes(): void {
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
    description: 'Find a single plugin matching the query filters. For a plugin that runs on its own image, '
      + 'the image\'s cosign signature is verified first; `imageDigest` in the response is the verified digest '
      + 'pipelines pin CodeBuild to.',
    tags,
    security: auth,
    responses: {
      200: { description: 'Plugin found' },
      404: { description: 'Not found' },
      409: { description: 'IMAGE_VERIFICATION_FAILED — the plugin image has no signed digest, or its signature did not verify' },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/plugins/lookup',
    summary: 'Resolve a single plugin (synth)',
    description: 'Same as `GET /plugins/find` with the filter in the body — the endpoint pipeline synth resolves '
      + 'plugins through. Verifies the plugin image signature before returning it.',
    tags,
    security: auth,
    responses: {
      200: { description: 'Plugin found' },
      400: { description: 'Missing or invalid filter' },
      404: { description: 'Not found' },
      409: { description: 'IMAGE_VERIFICATION_FAILED — the plugin image has no signed digest, or its signature did not verify' },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/plugins/{id}/sbom',
    summary: 'Download a plugin image SBOM',
    description: 'The SPDX JSON SBOM of the plugin image, read from its signed in-toto attestation — so the '
      + 'document returned is exactly what the platform generated and signed at build time.',
    tags,
    security: auth,
    responses: {
      200: { description: 'SPDX JSON document (application/spdx+json, served as an attachment)' },
      404: { description: 'Plugin not found, or the plugin has no image' },
      409: { description: 'IMAGE_VERIFICATION_FAILED — no SBOM attestation verified against the plugin-signing key' },
    },
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
    description: 'Upload a plugin ZIP file with spec. Builds Docker image and saves to database.',
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
}
