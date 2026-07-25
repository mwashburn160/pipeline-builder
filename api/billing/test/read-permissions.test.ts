// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC read-gate tests for the user-facing billing read routes.
 *
 * The `billing:read` capability was previously assignable but enforced nothing
 * ("gate writes only"). These routes now enforce it, so a bespoke custom role
 * that drops `billing:read` is actually blocked. Built-in Member/Admin bundles
 * already include the read, so built-in roles are unaffected.
 *
 * Gated (plain `requirePermission('billing:read')` — NO internal service reads
 * these; platform only POSTs /subscriptions and DELETEs by-org, so none needs
 * `requirePermissionOrService`):
 *   - GET /billing/usage
 *   - GET /billing/subscriptions
 *   - GET /billing/bundles
 *   - GET /billing/marketplace/entitlements
 *
 * Deliberately NOT gated (machine / unauthenticated plumbing): the public
 * GET /billing/plans[/:id] listing, POST /billing/marketplace/resolve, and the
 * SNS + Stripe webhooks — none are behind `requireAuth`.
 *
 * `requirePermission` is mocked with real semantics (checks the caller's
 * permission set) and the whole route stack is driven so the gate runs before
 * the handler, exactly as express would.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const passThrough = (_req: any, _res: any, next: () => void) => next();

const mockSendSuccess = jest.fn((res: any, status: number, data?: unknown) =>
  res.status(status).json({ success: true, statusCode: status, data }));
const mockSendError = jest.fn((res: any, status: number, msg: string, code?: string) =>
  res.status(status).json({ success: false, statusCode: status, message: msg, code }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireAuth: () => passThrough,
  requireSystemAdmin: passThrough,
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  sendBadRequest: mockSendError,
  validateBody: () => ({ ok: true, value: {} }),
  getParam: (params: Record<string, string>, key: string) => params[key],
  // Real gate semantics: 403 unless the caller holds the required permission.
  requirePermission: (perm: string) => (req: any, res: any, next: () => void) => {
    const perms: string[] = req.user?.permissions ?? [];
    if (perms.includes(perm)) return next();
    return res.status(403).json({ success: false, statusCode: 403, code: 'INSUFFICIENT_PERMISSIONS' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    try {
      await handler({ req, res, ctx: { log: jest.fn() }, orgId: req.orgId });
    } catch {
      mockSendError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    billingProvider: 'stripe',
    frontendUrl: 'https://app.example',
    marketplace: { snsTopicArn: undefined },
  },
}));

// -- helpers ------------------------------------------------------------------

const mockBuildUsageRollupFor = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({ usage: {} });
jest.unstable_mockModule('../src/helpers/usage-helpers.js', () => ({
  buildUsageRollupFor: (...a: unknown[]) => mockBuildUsageRollupFor(...a),
}));

const mockBundlesEnabled = jest.fn(() => false);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  bundlesEnabled: (...a: unknown[]) => mockBundlesEnabled(...(a as [])),
  bundleSelfServiceAllowed: () => true,
  getBundleCatalog: () => [],
  effectiveEntitlements: () => ({ limits: {} }),
  buildSubscriptionResponse: () => ({}),
  checkEntitlementOvercap: async () => [],
  createBillingEvent: async () => undefined,
  syncEntitlements: async () => undefined,
  calculatePeriodEnd: () => new Date(),
  // Routes widen their lookups to the non-terminal set; the real constant must
  // be present so the `$in` filters aren't `undefined`.
  MANAGEABLE_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due'],
}));

jest.unstable_mockModule('../src/helpers/stripe-helpers.js', () => ({
  mapStripeStatus: (s: string) => s,
}));

jest.unstable_mockModule('../src/helpers/marketplace-helpers.js', () => ({
  verifySNSSignature: jest.fn(),
  confirmSNSSubscription: jest.fn(),
  mapActionToStatus: jest.fn(),
}));

// -- models -------------------------------------------------------------------

const mockSubscriptionFindOne = jest.fn(() => ({ lean: async () => null }));
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: (...a: unknown[]) => mockSubscriptionFindOne(...(a as [])) },
}));

const mockPlanFindById = jest.fn(() => ({ lean: async () => null }));
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findById: (...a: unknown[]) => mockPlanFindById(...(a as [])) },
}));

jest.unstable_mockModule('../src/models/billing-event.js', () => ({
  BillingEvent: { deleteMany: jest.fn() },
}));

jest.unstable_mockModule('../src/models/webhook-dedupe.js', () => ({
  claimWebhookEvent: jest.fn(),
  releaseWebhookEvent: jest.fn(),
}));

// -- providers ----------------------------------------------------------------

const mockGetPaymentProvider = jest.fn<() => unknown>(() => ({}));
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => mockGetPaymentProvider(),
}));

// A non-marketplace provider (`{}`) is NOT an AWSMarketplaceProvider instance,
// so the entitlements route falls to its 400 "not configured" branch — which
// still proves the gate let the request THROUGH (400 ≠ 403).
class FakeAWSMarketplaceProvider {}
jest.unstable_mockModule('../src/providers/aws-marketplace-provider.js', () => ({
  AWSMarketplaceProvider: FakeAWSMarketplaceProvider,
}));

jest.unstable_mockModule('../src/validation/schemas.js', () => ({
  SubscriptionCreateSchema: {},
  SubscriptionUpdateSchema: {},
  AddonMutateSchema: {},
}));

const { createUsageRoutes } = await import('../src/routes/usage.js');
const { createSubscriptionRoutes } = await import('../src/routes/subscriptions.js');
const { createAddonRoutes } = await import('../src/routes/addons.js');
const { createMarketplaceRoutes } = await import('../src/routes/marketplace.js');

const usageRouter = createUsageRoutes();
const subscriptionRouter = createSubscriptionRoutes();
const addonRouter = createAddonRoutes();
const marketplaceRouter = createMarketplaceRoutes();

/** Drive the full middleware+handler stack for a route, like express would. */
async function runRoute(router: any, method: string, path: string, req: any, res: any) {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack as Array<{ handle: Function }>;
  let idx = 0;
  const next = async (): Promise<void> => {
    if (idx < stack.length) {
      const handle = stack[idx++].handle;
      await handle(req, res, next);
    }
  };
  await next();
}

function makeReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    headers: { authorization: 'Bearer tok' },
    orgId: 'org-1',
    user: { permissions: [], sub: 'user-1' },
    ...overrides,
  };
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const CASES: Array<{ name: string; router: any; method: string; path: string; downstream: jest.Mock }> = [
  { name: 'GET /usage', router: usageRouter, method: 'get', path: '/usage', downstream: mockBuildUsageRollupFor as unknown as jest.Mock },
  { name: 'GET /subscriptions', router: subscriptionRouter, method: 'get', path: '/subscriptions', downstream: mockSubscriptionFindOne as unknown as jest.Mock },
  { name: 'GET /bundles', router: addonRouter, method: 'get', path: '/bundles', downstream: mockBundlesEnabled as unknown as jest.Mock },
  { name: 'GET /marketplace/entitlements', router: marketplaceRouter, method: 'get', path: '/marketplace/entitlements', downstream: mockGetPaymentProvider as unknown as jest.Mock },
];

describe.each(CASES)('$name — requires billing:read', ({ router, method, path, downstream }) => {
  beforeEach(() => jest.clearAllMocks());

  it('403s a caller WITHOUT billing:read (handler never runs)', async () => {
    const { res, status, json } = makeRes();
    await runRoute(router, method, path, makeReq({ user: { permissions: [] } }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(downstream).not.toHaveBeenCalled();
  });

  it('lets a caller WITH billing:read through (handler runs, not 403)', async () => {
    const { res, status } = makeRes();
    await runRoute(router, method, path, makeReq({ user: { permissions: ['billing:read'] } }), res);

    expect(status).not.toHaveBeenCalledWith(403);
    expect(downstream).toHaveBeenCalled();
  });
});
