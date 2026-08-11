// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registry } from '../registry.js';

const tags = ['Pipeline Templates'];
const auth = [{ bearerAuth: [] }];

export function registerPipelineTemplateRoutes(): void {
  registry.registerPath({
    method: 'get',
    path: '/pipeline-templates',
    summary: 'List pipeline templates',
    description: 'List golden-path pipeline templates (own-org + shared system-org catalog) with pagination and filtering.',
    tags,
    security: auth,
    responses: { 200: { description: 'Paginated list of templates' }, 401: { description: 'Unauthorized' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/pipeline-templates/{id}',
    summary: 'Get a pipeline template by ID',
    tags,
    security: auth,
    responses: { 200: { description: 'Template details' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/pipeline-templates/{id}/instantiate',
    summary: 'Instantiate a template',
    description: 'Render a template into a concrete pipeline `props` by supplying its declared inputs. The returned props are submitted through the normal pipeline-create endpoint (compliance + quota apply there).',
    tags,
    security: auth,
    responses: { 200: { description: 'Resolved pipeline props' }, 400: { description: 'Invalid inputs' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/pipeline-templates',
    summary: 'Create a pipeline template',
    description: 'Author a golden-path template. Requires the `pipelines:write` permission.',
    tags,
    security: auth,
    responses: { 201: { description: 'Template created' }, 400: { description: 'Validation error' }, 403: { description: 'Forbidden' } },
  });

  registry.registerPath({
    method: 'put',
    path: '/pipeline-templates/{id}',
    summary: 'Update a pipeline template',
    tags,
    security: auth,
    responses: { 200: { description: 'Template updated' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'delete',
    path: '/pipeline-templates/{id}',
    summary: 'Delete a pipeline template',
    tags,
    security: auth,
    responses: { 200: { description: 'Template deleted' }, 404: { description: 'Not found' } },
  });
}
