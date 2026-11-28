// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Usage & billing stub data: two plans (Developer, Pro), an active monthly Pro
 * subscription, one stackable add-on, one billing event and an empty usage
 * breakdown. `stubBilling(api)` registers the reads of both Usage tabs.
 */

import { ok, type Backend } from '../backend';

export const PLANS = [
  { id: 'plan-dev', name: 'Developer', description: 'For individuals', tier: 'developer', prices: { monthly: 0, annual: 0 }, features: [], isDefault: true, sortOrder: 1 },
  { id: 'plan-pro', name: 'Pro', description: 'For teams', tier: 'pro', prices: { monthly: 4900, annual: 49000 }, features: [], isDefault: false, sortOrder: 2 },
];

export const SUBSCRIPTION = {
  id: 'sub-1', orgId: 'org-1', planId: 'plan-pro', planName: 'Pro', tier: 'pro', status: 'active', interval: 'monthly',
  currentPeriodStart: '2026-11-01T00:00:00Z', currentPeriodEnd: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false,
  dunning: null, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
};

export const BUNDLES = [
  {
    id: 'bundle-ci', name: 'Build minutes pack', description: '+500 CPU credits a month', grants: { cpuCredits: 500 },
    prices: { monthly: 1500, annual: 15000 }, currency: 'usd', stackable: true, maxQuantity: 10, availableForTiers: ['pro', 'team', 'business', 'enterprise'],
  },
];

export const EVENTS = [
  { id: 'ev-1', orgId: 'org-1', subscriptionId: 'sub-1', type: 'credit_applied', details: { amount: 1000 }, createdAt: '2026-11-18T00:00:00Z' },
];

export function stubBilling(api: Backend) {
  api.on('GET /api/billing/plans', ok({ plans: PLANS, total: PLANS.length }));
  api.on('GET /api/billing/subscriptions', ok({ subscription: SUBSCRIPTION }));
  api.on('GET /api/billing/bundles', ok({ bundles: BUNDLES, selfService: true, comboDiscounts: [] }));
  api.on('GET /api/billing/charges', ok({ priceBreakdown: null }));
  api.on('GET /api/billing/events', ok({ events: EVENTS, total: EVENTS.length }));
  api.on('GET /api/billing/marketplace/entitlements', ok({ entitlements: [] }));
  // No invoiced history yet, so the history section shows only the event log.
  api.on('GET /api/billing/summary', ok({ invoiceCount: 0 }));
  api.on('GET /api/billing/invoices', ok({ invoices: [], pagination: { total: 0, limit: 10, offset: 0 } }));
}
