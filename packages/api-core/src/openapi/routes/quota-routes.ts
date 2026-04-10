// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registry } from '../registry';

const tags = ['Quotas'];
const auth = [{ bearerAuth: [] }];

export function registerQuotaRoutes(): void {
  registry.registerPath({
    method: 'get',
    path: '/quotas',
    summary: 'Get own quotas',
    description: 'Get quota usage and limits for the current organization (from JWT).',
    tags,
    security: auth,
    responses: { 200: { description: 'Organization quota details' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/quotas/all',
    summary: 'Get all org quotas',
    description: 'Get quotas for all organizations. System admin only.',
    tags,
    security: auth,
    responses: { 200: { description: 'All organization quotas' }, 403: { description: 'Admin required' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/quotas/{orgId}',
    summary: 'Get org quotas',
    description: 'Get quota usage and limits for a specific organization.',
    tags,
    security: auth,
    responses: { 200: { description: 'Organization quota details' }, 404: { description: 'Organization not found' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/quotas/{orgId}/{quotaType}',
    summary: 'Get specific quota',
    description: 'Get a specific quota type for an organization.',
    tags,
    security: auth,
    responses: { 200: { description: 'Quota type details' } },
  });

  registry.registerPath({
    method: 'put',
    path: '/quotas/{orgId}',
    summary: 'Update org quotas',
    description: 'Update quota limits for an organization. System admin only.',
    tags,
    security: auth,
    responses: { 200: { description: 'Quotas updated' }, 403: { description: 'Admin required' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/quotas/{orgId}/reset',
    summary: 'Reset quota usage',
    description: 'Reset usage counters for an organization. Admin only.',
    tags,
    security: auth,
    responses: { 200: { description: 'Quota usage reset' }, 403: { description: 'Admin required' } },
  });
}
