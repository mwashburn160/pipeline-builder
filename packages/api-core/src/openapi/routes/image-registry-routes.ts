// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registry } from '../registry.js';

const tags = ['Image Registry'];
const auth = [{ bearerAuth: [] }];

/**
 * OpenAPI definitions for the image-registry service (api/image-registry): the
 * Docker-registry token endpoint (`/token`), the org-scoped image API
 * (`/api/images`), and the admin API (`/api/admin`). Image read/write is gated by
 * the `registry:read` / `registry:write` permissions.
 */
export function registerImageRegistryRoutes(): void {
  registry.registerPath({
    method: 'get',
    path: '/token',
    summary: 'Mint a Docker registry token',
    description: 'OAuth2-style token endpoint for `docker`/`crane`/`buildctl` clients. Verifies Basic-auth creds (a platform JWT or user login) and issues a scoped bearer token for pull/push.',
    tags,
    responses: { 200: { description: 'Registry access token' }, 401: { description: 'Invalid credentials' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/images',
    summary: 'List images',
    description: "List the organization's container images in the registry.",
    tags,
    security: auth,
    responses: { 200: { description: 'Image list' }, 403: { description: 'registry:read required' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/images/{name}/tags',
    summary: 'List image tags',
    tags,
    security: auth,
    responses: { 200: { description: 'Tag list' }, 404: { description: 'Image not found' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/images/{name}/manifests/{reference}',
    summary: 'Get an image manifest',
    tags,
    security: auth,
    responses: { 200: { description: 'OCI manifest / index' }, 404: { description: 'Manifest not found' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/images/{name}/blobs/{digest}',
    summary: 'Get an image blob',
    tags,
    security: auth,
    responses: { 200: { description: 'Blob content' }, 404: { description: 'Blob not found' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/images/copy',
    summary: 'Copy an image',
    description: 'Server-side copy of an image between repositories. Requires both registry:read and registry:write.',
    tags,
    security: auth,
    responses: { 200: { description: 'Image copied' }, 403: { description: 'registry:read + registry:write required' } },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/images/{name}',
    summary: 'Delete an image repository',
    tags,
    security: auth,
    responses: { 200: { description: 'Repository deleted' }, 403: { description: 'registry:write required' } },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/images/{name}/manifests/{reference}',
    summary: 'Delete an image manifest/tag',
    tags,
    security: auth,
    responses: { 200: { description: 'Manifest deleted' }, 403: { description: 'registry:write required' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/storage/{prefix}',
    summary: 'Registry storage rollup',
    description: 'Storage usage rollup under a prefix (registry:read).',
    tags,
    security: auth,
    responses: { 200: { description: 'Storage usage' }, 403: { description: 'registry:read required' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/gc',
    summary: 'Run registry garbage collection',
    description: 'Trigger blob/manifest garbage collection (registry:write).',
    tags,
    security: auth,
    responses: { 202: { description: 'GC started' }, 403: { description: 'registry:write required' } },
  });
}
