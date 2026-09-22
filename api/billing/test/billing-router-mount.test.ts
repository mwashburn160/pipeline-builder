// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Router-MOUNT regression test: every billing router is mounted at `/billing`
 * in src/app-routes.ts, one after another. A feature gate registered as a
 * PATH-LESS `router.use(...)` inside an early router (discounts, promotions) runs
 * for EVERY request that reaches that router — so with the flag off it 404'd every
 * LATER billing router too (summary, usage, admin, marketplace, the Stripe webhook).
 *
 * This suite loads the REAL routers, mounts them on a real express app in the
 * exact order src/app-routes.ts does (parsed from the source so it can't drift),
 * and drives HTTP requests with each flag off: the flagged surface still 404s, and
 * a later router (the Stripe webhook, which needs no DB) is still reachable.
 */

import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// REAL api-core / api-server / pipeline-core: the gates under test run before any
// auth or DB work, and the probed webhook path needs neither — so nothing but the
// config flags and the payment provider has to be faked.

// Mutable flags — each describe flips one off.
const mockConfig = {
  billingProvider: 'stub',
  frontendUrl: '',
  discounts: { enabled: true, maxPercent: 100, maxCents: 1_000_000 },
  promotions: { enabled: true, backfillIntervalMs: 3_600_000, clawbackWindowMs: 1 },
  marketplace: { snsTopicArns: [] as string[] },
  stripe: { priceToPlanMap: {} },
  quotaService: { host: 'quota', port: 3000 },
  platformService: { host: 'platform', port: 3000 },
};
jest.unstable_mockModule('../src/config.js', () => ({ config: mockConfig }));

// Not a StripeProvider instance → the webhook answers its own 400 "not configured"
// WITHOUT touching the DB, proving the request reached the (last-mounted) router.
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({}),
}));

const appRoutes = readFileSync(new URL('../src/app-routes.ts', import.meta.url), 'utf8');
/** Router factory names in the order src/app-routes.ts mounts them at `/billing`. */
const mountOrder = [...appRoutes.matchAll(/app\.use\('\/billing',\s*(create\w+Routes)\(\)\)/g)].map((m) => m[1]);

const routeModules = {
  createReadPlanRoutes: '../src/routes/read-plans.js',
  createSubscriptionRoutes: '../src/routes/subscriptions.js',
  createAddonRoutes: '../src/routes/addons.js',
  createDiscountRoutes: '../src/routes/discounts.js',
  createPromotionRoutes: '../src/routes/promotions.js',
  createBillingSummaryRoutes: '../src/routes/billing-summary.js',
  createUsageRoutes: '../src/routes/usage.js',
  createAdminSubscriptionRoutes: '../src/routes/admin-subscriptions.js',
  createMarketplaceRoutes: '../src/routes/marketplace.js',
  createStripeWebhookRoutes: '../src/routes/stripe-webhook.js',
} as Record<string, string>;

const express = (await import('express')).default;

let baseUrl = '';
let server: import('node:http').Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  for (const name of mountOrder) {
    const path = routeModules[name];
    if (!path) throw new Error(`app-routes.ts mounts ${name} — add it to routeModules`);
    const mod = await import(path) as Record<string, () => import('express').Router>;
    app.use('/billing', mod[name]());
  }
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  return { status: r.status, body: await r.json() };
}

describe('billing router mount order', () => {
  it('parses every /billing router mount from src/app-routes.ts, discounts/promotions before the webhook', () => {
    expect(mountOrder.length).toBeGreaterThanOrEqual(10);
    expect(mountOrder.indexOf('createDiscountRoutes')).toBeLessThan(mountOrder.indexOf('createStripeWebhookRoutes'));
    expect(mountOrder.indexOf('createPromotionRoutes')).toBeLessThan(mountOrder.indexOf('createStripeWebhookRoutes'));
  });
});

describe.each([
  { flag: 'discounts', gatedPath: '/billing/admin/discounts', message: 'Discounts are not enabled' },
  { flag: 'promotions', gatedPath: '/billing/admin/promotions', message: 'Promotions are not enabled' },
] as const)('with $flag disabled', ({ flag, gatedPath, message }) => {
  beforeAll(() => { mockConfig[flag].enabled = false; });
  afterAll(() => { mockConfig[flag].enabled = true; });

  it('still 404s the flagged surface', async () => {
    const r = await post(gatedPath);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ message, code: 'NOT_FOUND' });
  });

  it('does NOT 404 a later-mounted router (the Stripe webhook is reachable)', async () => {
    const r = await post('/billing/stripe/webhook', { 'stripe-signature': 'sig' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Stripe provider is not configured');
  });
});
