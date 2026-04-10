// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registry } from '../registry';

const tags = ['Billing'];
const auth = [{ bearerAuth: [] }];

export function registerBillingRoutes(): void {
  registry.registerPath({
    method: 'get',
    path: '/billing/plans',
    summary: 'List active plans',
    description: 'List all active billing plans. No authentication required.',
    tags,
    responses: { 200: { description: 'List of active billing plans' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/billing/plans/{planId}',
    summary: 'Get plan by ID',
    tags,
    responses: { 200: { description: 'Plan details' }, 404: { description: 'Plan not found' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/billing/subscriptions',
    summary: 'Create subscription',
    description: 'Create a new billing subscription for the current organization.',
    tags,
    security: auth,
    responses: { 201: { description: 'Subscription created' }, 400: { description: 'Validation error' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/billing/subscriptions',
    summary: 'List subscriptions',
    description: 'List billing subscriptions for the current organization.',
    tags,
    security: auth,
    responses: { 200: { description: 'List of subscriptions' } },
  });

  registry.registerPath({
    method: 'put',
    path: '/billing/subscriptions/{id}',
    summary: 'Update subscription',
    tags,
    security: auth,
    responses: { 200: { description: 'Subscription updated' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'delete',
    path: '/billing/subscriptions/{id}',
    summary: 'Cancel subscription',
    tags,
    security: auth,
    responses: { 200: { description: 'Subscription cancelled' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/billing/marketplace',
    summary: 'AWS Marketplace integration',
    description: 'Handle AWS Marketplace subscription events.',
    tags,
    security: auth,
    responses: { 200: { description: 'Marketplace event processed' } },
  });
}
