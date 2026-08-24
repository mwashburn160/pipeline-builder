// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/subscriptions.
 *
 * Tests the subscription CRUD routes by extracting handlers from
 * the router. Mocks Mongoose models, payment provider, and helpers.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks — must be defined before imports

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockSendBadRequest = jest.fn();
const mockValidateBody = jest.fn();
const mockIsSystemAdmin = jest.fn();
const mockRequireAuth = jest.fn((_opts?: any) => (_req: any, _res: any, next: () => void) => next());

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  sendBadRequest: mockSendBadRequest,
  requireAuth: mockRequireAuth,
  requirePermission: () => (_req: any, _res: any, next: () => void) => next(),
  isSystemAdmin: mockIsSystemAdmin,
  requireSystemAdmin: (_req: any, _res: any, next: () => void) => next(),
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  getServiceAuthHeader: jest.fn(() => 'Bearer service-token'),
  validateBody: mockValidateBody,
  createCacheService: () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn(), invalidate: jest.fn() }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const orgId = req.user?.organizationId || '';
    const userId = req.user?.sub || '';
    const ctx = { log: jest.fn(), identity: { orgId, userId }, requestId: 'req-1' };
    if (!orgId) {
      return mockSendError(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
    }
    try {
      await handler({ req, res, ctx, orgId, userId });
    } catch {
      // withRoute catches unhandled errors and returns 500
      mockSendError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  },
}));

const mockSubscriptionFindOne = jest.fn<(...args: unknown[]) => any>();
const mockSubscriptionCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSubscriptionDeleteOne = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ deletedCount: 1 });
const mockSubscriptionFind = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]);
const mockSubscriptionDeleteMany = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ deletedCount: 0 });

jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    findOne: mockSubscriptionFindOne,
    create: mockSubscriptionCreate,
    deleteOne: mockSubscriptionDeleteOne,
    find: mockSubscriptionFind,
    deleteMany: mockSubscriptionDeleteMany,
  },
}));

const mockBillingEventDeleteMany = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ deletedCount: 0 });
jest.unstable_mockModule('../src/models/billing-event.js', () => ({
  BillingEvent: { deleteMany: mockBillingEventDeleteMany },
}));

// Central-trail audit client — the route emits billing.subscription.* here
// ALONGSIDE the local billing_events write. Mock it so we can assert emission.
const mockAuditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  getAuditClient: () => ({ record: mockAuditRecord }),
}));

const mockPlanFindOne = jest.fn<(...args: unknown[]) => any>();
const mockPlanFindById = jest.fn<(...args: unknown[]) => any>();

jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: {
    findOne: mockPlanFindOne,
    findById: mockPlanFindById,
  },
}));

const mockCreateCustomer = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCreateSubscription = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCreateCheckoutSession = jest.fn<(...args: unknown[]) => Promise<string>>();
const mockUpdateSubscription = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCancelSubscription = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockReactivateSubscription = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({
    createCustomer: mockCreateCustomer,
    createSubscription: mockCreateSubscription,
    createCheckoutSession: mockCreateCheckoutSession,
    updateSubscription: mockUpdateSubscription,
    cancelSubscription: mockCancelSubscription,
    reactivateSubscription: mockReactivateSubscription,
  }),
}));

const mockBuildSubscriptionResponse = jest.fn((sub: any, planName?: string) => ({
  id: sub._id?.toString() || sub.id,
  planId: sub.planId,
  ...(planName !== undefined && { planName }),
  status: sub.status,
}));
const mockCalculatePeriodEnd = jest.fn(() => new Date('2026-04-01'));
const mockCreateBillingEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockSyncTierToQuotaService = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
// Double-billing prune: default to a no-op passthrough (keeps existing plan-change
// tests unaffected). applyTierIncludedAddonPrune mutates subscription.addons in
// place and returns the pruned list; the dedicated prune test overrides it.
const mockApplyTierIncludedAddonPrune = jest.fn(
  (_sub: { addons?: Array<{ bundleId: string; quantity: number }> }) => [] as Array<{ bundleId: string; features: string[] }>,
);
// finalizePrunedAddons runs the post-save side effects (provider line-item removal
// + audit); the route just wires it, so we assert the call shape here and unit-test
// the actual provider removal in addon-prune.test.ts.
const mockFinalizePrunedAddons = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
// applyPlanTierChange is a FAITHFUL re-implementation of the real helper (the
// deferred sync → event → finalize sequence) so the route's downstream calls
// stay observable on the existing spies. The route just wires it + invokes the
// returned thunk after save.
const mockApplyPlanTierChange = jest.fn((subscription: any, plan: { tier: string }, opts: any) => async () => {
  const auth = opts.authHeader ?? 'Bearer service-token';
  await mockSyncTierToQuotaService(subscription.orgId, plan.tier, auth, subscription._id.toString(), subscription.addons ?? []);
  if (opts.event) {
    await mockCreateBillingEvent(subscription.orgId, opts.event.type, opts.event.details, subscription._id.toString(), opts.actorId);
  } else {
    await mockCreateBillingEvent(subscription.orgId, 'plan_changed', { oldPlanId: opts.oldPlanId, newPlanId: opts.newPlanId, ...opts.eventDetails }, subscription._id.toString(), opts.actorId);
  }
  await mockFinalizePrunedAddons(opts.pruned, subscription.addons ?? [], {
    orgId: subscription.orgId,
    subscriptionId: subscription._id.toString(),
    interval: subscription.interval,
    externalId: subscription.externalId,
    actorId: opts.actorId,
    source: opts.source,
  });
});

jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  applyPlanTierChange: mockApplyPlanTierChange,
  billingServiceAuth: (_orgId: string) => 'Bearer service-token',
  buildSubscriptionResponse: mockBuildSubscriptionResponse,
  calculatePeriodEnd: mockCalculatePeriodEnd,
  createBillingEvent: mockCreateBillingEvent,
  syncTierToQuotaService: mockSyncTierToQuotaService,
  syncEntitlements: mockSyncTierToQuotaService,
  syncProviderAddons: jest.fn(async () => undefined),
  // Over-cap gate: default to "no overages" so plan-change tests proceed.
  checkEntitlementOvercap: async () => [],
  applyTierIncludedAddonPrune: mockApplyTierIncludedAddonPrune,
  finalizePrunedAddons: mockFinalizePrunedAddons,
  // The routes now widen their lookups to the non-terminal set; re-export the
  // real constant so the `$in` filters aren't `undefined`.
  MANAGEABLE_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due'],
}));

// The prune/plan-change helpers moved to addon-prune.js — the route imports them
// from there now, so mock that module (same stubs) or the real one loads.
jest.unstable_mockModule('../src/helpers/addon-prune.js', () => ({
  applyPlanTierChange: mockApplyPlanTierChange,
  applyTierIncludedAddonPrune: mockApplyTierIncludedAddonPrune,
  finalizePrunedAddons: mockFinalizePrunedAddons,
}));

jest.unstable_mockModule('../src/validation/schemas.js', () => ({
  SubscriptionCreateSchema: {},
  SubscriptionUpdateSchema: {},
}));

// Route now reads config.billingProvider (stamped onto the subscription's
// metadata.provider). Mock config so importing it doesn't run the real
// env-validation (which throws without MONGODB_URI).
jest.unstable_mockModule('../src/config.js', () => ({
  config: { billingProvider: 'stripe', frontendUrl: 'https://app.example' },
}));

const { createSubscriptionRoutes } = await import('../src/routes/subscriptions.js');

const router = createSubscriptionRoutes();

// Helpers

/**
 * Extract the last handler from a route stack (skips middleware like
 * requireAuth and requireSystemAdmin).
 */
function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  // The actual handler is the last in the stack (after auth middleware)
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    headers: { authorization: 'Bearer tok' },
    user: { organizationId: 'org-1', sub: 'user-1' },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'sub-1' },
    orgId: 'org-1',
    planId: 'pro',
    status: 'active',
    interval: 'monthly',
    currentPeriodStart: new Date('2026-03-01'),
    currentPeriodEnd: new Date('2026-04-01'),
    cancelAtPeriodEnd: false,
    externalId: 'ext-sub-1',
    externalCustomerId: 'ext-cust-1',
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Tests

describe('GET /subscriptions', () => {
  const handler = getHandler('get', '/subscriptions');

  beforeEach(() => jest.clearAllMocks());

  it('returns current org subscription', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) });
    mockPlanFindById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Pro' }) });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      subscription: expect.objectContaining({ id: 'sub-1', planId: 'pro' }),
    });
  });

  it('returns null subscription when none exists', async () => {
    mockSubscriptionFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { subscription: null });
  });

  it('looks up the full non-terminal status set (active + trialing + past_due), not just active', async () => {
    mockSubscriptionFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    await handler(mockReq(), mockRes());

    expect(mockSubscriptionFindOne).toHaveBeenCalledWith({
      orgId: 'org-1',
      status: { $in: expect.arrayContaining(['active', 'trialing', 'past_due']) },
    });
    // Terminal states must NOT be included.
    const [{ status }] = mockSubscriptionFindOne.mock.calls[0] as [{ status: { $in: string[] } }];
    expect(status.$in).not.toContain('canceled');
  });

  it('surfaces a trialing subscription (invisible before the fix)', async () => {
    const sub = makeSubscription({ status: 'trialing' });
    mockSubscriptionFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) });
    mockPlanFindById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Pro' }) });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      subscription: expect.objectContaining({ id: 'sub-1', status: 'trialing' }),
    });
  });

  it('returns 400 when orgId is missing', async () => {
    const req = mockReq({ user: { sub: 'user-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on database error', async () => {
    mockSubscriptionFindOne.mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('DB down')) });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Internal server error', 'INTERNAL_ERROR');
  });
});

describe('POST /subscriptions/checkout', () => {
  const handler = getHandler('post', '/subscriptions/checkout');

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro', interval: 'monthly' } });
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true, prices: { monthly: 3900, annual: 39000 } });
    mockSubscriptionFindOne.mockResolvedValue(null);
    mockCreateCustomer.mockResolvedValue('cust-1');
    mockCreateCheckoutSession.mockResolvedValue('https://checkout.stripe/xyz');
  });

  it('returns a hosted Checkout URL and stamps orgId + success/cancel URLs', async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { url: 'https://checkout.stripe/xyz' });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith('cust-1', 'pro', 'monthly', {
      orgId: 'org-1',
      successUrl: 'https://app.example/dashboard/billing?checkout=success',
      cancelUrl: 'https://app.example/dashboard/billing?checkout=cancelled',
    });
    // No local subscription is created here — the webhook provisions it on completion.
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
  });

  it('409s when the org already has a manageable subscription', async () => {
    mockSubscriptionFindOne.mockResolvedValue(makeSubscription());
    const res = mockRes();
    await handler(mockReq(), res);
    expect(mockSendError).toHaveBeenCalledWith(res, 409, expect.any(String), expect.anything());
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('400s a free plan (use the direct create instead)', async () => {
    mockPlanFindOne.mockResolvedValue({ _id: 'developer', name: 'Developer', tier: 'developer', isActive: true, prices: { monthly: 0, annual: 0 } });
    const res = mockRes();
    await handler(mockReq(), res);
    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.stringContaining('free'), expect.anything());
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });
});

describe('POST /subscriptions', () => {
  const handler = getHandler('post', '/subscriptions');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro', interval: 'monthly' } });
    mockCreateCustomer.mockResolvedValue('ext-cust-1');
    // Providers now return the real provider status; `active` is the settled,
    // entitlement-worthy case used by the happy-path tests.
    mockCreateSubscription.mockResolvedValue({ externalId: 'ext-sub-1', externalCustomerId: 'ext-cust-1', status: 'active' });
  });

  it('creates a subscription successfully', async () => {
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockSubscriptionFindOne.mockResolvedValue(null);
    const createdSub = makeSubscription();
    mockSubscriptionCreate.mockResolvedValue(createdSub);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 201, {
      subscription: expect.objectContaining({ id: 'sub-1' }),
    });
    // Service token, not the user's bearer — see subscriptions.ts comment.
    // 4th arg is subscriptionId so the quota service can audit the trigger.
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'pro', 'Bearer service-token', 'sub-1');
    // 5th arg = actorId, the acting user (req.user.sub).
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'subscription_created', expect.any(Object), expect.any(String), 'user-1');
  });

  it('grants entitlements when the provider reports a trialing subscription', async () => {
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockSubscriptionFindOne.mockResolvedValue(null);
    const createdSub = makeSubscription();
    mockSubscriptionCreate.mockResolvedValue(createdSub);
    mockCreateSubscription.mockResolvedValue({ externalId: 'ext-sub-1', externalCustomerId: 'ext-cust-1', status: 'trialing' });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // trialing is entitlement-worthy — paid caps are granted and the local
    // status reflects the provider's real state.
    expect(createdSub.status).toBe('trialing');
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'pro', 'Bearer service-token', 'sub-1');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 201, expect.any(Object));
  });

  it('persists an incomplete subscription WITHOUT granting paid entitlements', async () => {
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockSubscriptionFindOne.mockResolvedValue(null);
    const createdSub = makeSubscription();
    mockSubscriptionCreate.mockResolvedValue(createdSub);
    // No card on file → Stripe returns `incomplete`; we must NOT grant paid caps.
    mockCreateSubscription.mockResolvedValue({ externalId: 'ext-sub-1', externalCustomerId: 'ext-cust-1', status: 'incomplete' });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // Row is persisted (saved + billing event) but the org stays unprovisioned:
    // syncEntitlements is skipped until the later updated→active webhook.
    expect(createdSub.status).toBe('incomplete');
    expect(createdSub.save).toHaveBeenCalled();
    expect(mockSyncTierToQuotaService).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'subscription_created', expect.any(Object), expect.any(String), 'user-1');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 201, expect.any(Object));
  });

  it('returns 400 when orgId is missing', async () => {
    const req = mockReq({ user: { sub: 'user-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns validation error on bad body', async () => {
    mockValidateBody.mockReturnValue({ ok: false, error: 'planId is required' });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendBadRequest).toHaveBeenCalledWith(res, 'planId is required', 'VALIDATION_ERROR');
  });

  it('returns 404 when plan not found', async () => {
    mockPlanFindOne.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Plan not found', 'NOT_FOUND');
  });

  it('returns 409 when active subscription already exists', async () => {
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro' });
    mockSubscriptionFindOne.mockResolvedValue(makeSubscription());

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 409, expect.stringContaining('already has an active subscription'), 'DUPLICATE_ENTRY');
  });

  it('returns 500 on payment provider error', async () => {
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro' });
    mockSubscriptionFindOne.mockResolvedValue(null);
    mockCreateCustomer.mockRejectedValue(new Error('Payment API down'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Internal server error', 'INTERNAL_ERROR');
  });
});

describe('PUT /subscriptions/:id', () => {
  const handler = getHandler('put', '/subscriptions/:id');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'enterprise' } });
  });

  it('updates subscription plan', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'enterprise', name: 'Enterprise', tier: 'enterprise' });
    mockUpdateSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      subscription: expect.any(Object),
    });
    expect(sub.save).toHaveBeenCalled();
  });

  it('returns 400 when neither planId nor interval provided', async () => {
    mockValidateBody.mockReturnValue({ ok: true, value: {} });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, 'At least planId or interval is required', 'VALIDATION_ERROR');
  });

  it('returns 404 when subscription not found', async () => {
    mockSubscriptionFindOne.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Active subscription not found', 'NOT_FOUND');
  });

  it('returns 404 when new plan not found', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Plan not found', 'NOT_FOUND');
  });

  it('captures correct old planId in billing event', async () => {
    const sub = makeSubscription({ planId: 'developer' });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'enterprise', name: 'Enterprise', tier: 'enterprise', isActive: true });
    mockUpdateSubscription.mockResolvedValue(undefined);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'enterprise' } });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'plan_changed',
      { oldPlanId: 'developer', newPlanId: 'enterprise' },
      'sub-1', 'user-1',
    );
  });

  it('prunes a tier-included pure-feature add-on on plan change, syncs the reduced list, and removes the provider line item (double-billing fix)', async () => {
    const sub = makeSubscription({
      planId: 'pro',
      addons: [
        { bundleId: 'advanced_reporting', quantity: 1 },
        { bundleId: 'seat_pack', quantity: 2 },
      ],
    });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'enterprise', name: 'Enterprise', tier: 'enterprise', isActive: true });
    mockUpdateSubscription.mockResolvedValue(undefined);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'enterprise' } });

    // enterprise bundles in advanced_reporting, so the pure-feature add-on is
    // dropped; the quota pack (seat_pack) is retained. Mirror the real helper:
    // mutate subscription.addons in place and return the pruned bundle.
    const reduced = [{ bundleId: 'seat_pack', quantity: 2 }];
    const pruned = [{ bundleId: 'advanced_reporting', features: ['advanced_reporting'] }];
    mockApplyTierIncludedAddonPrune.mockImplementationOnce((s: any) => { s.addons = reduced; return pruned; });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    // Persisted subscription no longer carries the now-bundled add-on...
    expect(sub.addons).toEqual(reduced);
    expect(sub.save).toHaveBeenCalled();
    // ...the REDUCED set (not the original) is what gets synced downstream...
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith(
      'org-1', 'enterprise', 'Bearer service-token', 'sub-1', reduced,
    );
    // ...and the provider line-item removal fires (post-save) with the pruned
    // bundle + the reduced list + the sub's external id / cadence.
    expect(mockFinalizePrunedAddons).toHaveBeenCalledWith(
      pruned,
      reduced,
      expect.objectContaining({
        orgId: 'org-1',
        subscriptionId: 'sub-1',
        interval: 'monthly',
        externalId: 'ext-sub-1',
        actorId: 'user-1',
      }),
    );
  });

  it('does NOT invoke the provider add-on removal when a plan change prunes nothing', async () => {
    const sub = makeSubscription({ planId: 'pro', addons: [{ bundleId: 'seat_pack', quantity: 2 }] });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'enterprise', name: 'Enterprise', tier: 'enterprise', isActive: true });
    mockUpdateSubscription.mockResolvedValue(undefined);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'enterprise' } });

    // Default applyTierIncludedAddonPrune returns [] (no prune). finalize is still
    // called by the route, but with an empty pruned list (a no-op in the real impl).
    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockFinalizePrunedAddons).toHaveBeenCalledWith([], [{ bundleId: 'seat_pack', quantity: 2 }], expect.any(Object));
  });

  it('captures correct old interval in billing event', async () => {
    const sub = makeSubscription({ interval: 'monthly' });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { interval: 'annual' } });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'interval_changed',
      { oldInterval: 'monthly', newInterval: 'annual' },
      'sub-1', 'user-1',
    );
  });

  it('interval-only change pushes the NEW interval to the provider (mischarge fix)', async () => {
    const sub = makeSubscription({ planId: 'pro', interval: 'monthly' });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { interval: 'annual' } });
    mockUpdateSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    // Old code skipped the provider entirely on an interval-only change; now the
    // current plan is re-pushed AT the new interval so billing re-cadences.
    expect(mockUpdateSubscription).toHaveBeenCalledWith('ext-sub-1', 'pro', 'annual');
    expect(sub.save).toHaveBeenCalled();
  });

  it('combined plan+interval change applies the new plan AT the new interval', async () => {
    const sub = makeSubscription({ planId: 'pro', interval: 'monthly' });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'enterprise', name: 'Enterprise', tier: 'enterprise', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'enterprise', interval: 'annual' } });
    mockUpdateSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockUpdateSubscription).toHaveBeenCalledWith('ext-sub-1', 'enterprise', 'annual');
  });

  it('plan-only change preserves the current interval on the provider call', async () => {
    const sub = makeSubscription({ planId: 'pro', interval: 'monthly' });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'enterprise', name: 'Enterprise', tier: 'enterprise', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'enterprise' } });
    mockUpdateSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockUpdateSubscription).toHaveBeenCalledWith('ext-sub-1', 'enterprise', 'monthly');
  });
});

describe('POST /subscriptions/:id/cancel', () => {
  const handler = getHandler('post', '/subscriptions/:id/cancel');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
  });

  it('cancels subscription at period end', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(sub.save).toHaveBeenCalled();
    expect(mockCancelSubscription).toHaveBeenCalledWith('ext-sub-1');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      message: expect.stringContaining('canceled'),
    }));
  });

  it('returns 404 when active subscription not found', async () => {
    mockSubscriptionFindOne.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Active subscription not found', 'NOT_FOUND');
  });

  it('looks up the sub across the non-terminal status set (trialing/past_due cancelable)', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockResolvedValue(undefined);

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockSubscriptionFindOne).toHaveBeenCalledWith({
      _id: 'sub-1',
      orgId: 'org-1',
      status: { $in: expect.arrayContaining(['active', 'trialing', 'past_due']) },
    });
  });

  it('cancels a trialing subscription (trial customer can cancel before conversion)', async () => {
    const sub = makeSubscription({ status: 'trialing' });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockResolvedValue(undefined);

    const res = mockRes();
    await handler(mockReq({ params: { id: 'sub-1' } }), res);

    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(mockCancelSubscription).toHaveBeenCalledWith('ext-sub-1');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      message: expect.stringContaining('canceled'),
    }));
  });

  it('cancels a past_due subscription (grace customer can stop dunning)', async () => {
    const sub = makeSubscription({ status: 'past_due' });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockResolvedValue(undefined);

    const res = mockRes();
    await handler(mockReq({ params: { id: 'sub-1' } }), res);

    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(mockCancelSubscription).toHaveBeenCalledWith('ext-sub-1');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      message: expect.stringContaining('canceled'),
    }));
  });

  it('returns 500 on provider error', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockRejectedValue(new Error('Provider timeout'));

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Internal server error', 'INTERNAL_ERROR');
  });

  it('mirrors the cancel to the CENTRAL audit trail with plan/subscription ids', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    await handler(req, mockRes());

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.subscription.cancel',
        actorId: 'user-1',
        orgId: 'org-1',
        targetId: 'sub-1',
        details: expect.objectContaining({ planId: 'pro', orgId: 'org-1' }),
      }),
      'billing',
    );
  });

  it('never emits card/payment secrets or an account id in the cancel details', async () => {
    // A subscription doc carrying provider/card fields must NOT leak into the trail.
    const sub = makeSubscription({
      externalCustomerId: 'cus_LEAKED',
      stripeCustomerId: 'cus_LEAKED',
      cardLast4: '4242',
      awsAccountId: '123456789012',
    });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockResolvedValue(undefined);

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    const [event] = mockAuditRecord.mock.calls[0];
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('cus_LEAKED');
    expect(serialized).not.toContain('4242');
    expect(serialized).not.toContain('123456789012');
  });

  it('does not emit to the central trail when the provider cancel fails', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockRejectedValue(new Error('Provider timeout'));

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

describe('DELETE /subscriptions/by-org/:orgId (cascade)', () => {
  const handler = getHandler('delete', '/subscriptions/by-org/:orgId');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
    mockSubscriptionDeleteMany.mockResolvedValue({ deletedCount: 1 });
    mockBillingEventDeleteMany.mockResolvedValue({ deletedCount: 2 });
  });

  it('mirrors each removed subscription to the CENTRAL audit trail (no secrets)', async () => {
    const sub = makeSubscription({
      _id: { toString: () => 'sub-9' },
      orgId: 'org-9',
      externalCustomerId: 'cus_LEAKED',
      stripeCustomerId: 'cus_LEAKED',
    });
    mockSubscriptionFind.mockReturnValue({ limit: jest.fn().mockResolvedValue([sub]) });
    mockCancelSubscription.mockResolvedValue(undefined);

    // withRoute mock gates on req.user.organizationId; the handler itself uses the
    // :orgId param + req.user.sub (a sysadmin / service caller here).
    const req = mockReq({ params: { orgId: 'org-9' }, user: { organizationId: 'sys-org', sub: 'sysadmin-1' } });
    await handler(req, mockRes());

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.subscription.delete',
        actorId: 'sysadmin-1',
        orgId: 'org-9',
        targetId: 'sub-9',
        details: expect.objectContaining({ planId: 'pro', orgId: 'org-9' }),
      }),
      'billing',
    );
    const [event] = mockAuditRecord.mock.calls[0];
    expect(JSON.stringify(event)).not.toContain('cus_LEAKED');
  });

  it('looks up the manageable (non-terminal) set, not just active, for the provider-cancel sweep', async () => {
    mockSubscriptionFind.mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const req = mockReq({ params: { orgId: 'org-9' }, user: { organizationId: 'sys-org', sub: 'sysadmin-1' } });
    await handler(req, mockRes());

    expect(mockSubscriptionFind).toHaveBeenCalledWith({
      orgId: 'org-9',
      status: { $in: expect.arrayContaining(['active', 'trialing', 'past_due']) },
    });
  });

  it('provider-cancels a trialing sub before the local cascade (live externalId would keep billing otherwise)', async () => {
    // A trialing row carries a live externalId at the provider. Before the fix
    // the sweep matched only status:'active', so deleteMany wiped the local row
    // while the provider kept billing with nothing left to reconcile.
    const trialing = makeSubscription({
      _id: { toString: () => 'sub-trial' },
      orgId: 'org-9',
      status: 'trialing',
      externalId: 'ext-trial-1',
    });
    mockSubscriptionFind.mockReturnValue({ limit: jest.fn().mockResolvedValue([trialing]) });
    mockCancelSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { orgId: 'org-9' }, user: { organizationId: 'sys-org', sub: 'sysadmin-1' } });
    await handler(req, mockRes());

    expect(mockCancelSubscription).toHaveBeenCalledWith('ext-trial-1');
    expect(mockSubscriptionDeleteMany).toHaveBeenCalledWith({ orgId: 'org-9' });
  });

  it('continues the local cascade when a provider-cancel fails (fail-soft)', async () => {
    const trialing = makeSubscription({
      _id: { toString: () => 'sub-trial' },
      orgId: 'org-9',
      status: 'trialing',
      externalId: 'ext-trial-1',
    });
    mockSubscriptionFind.mockReturnValue({ limit: jest.fn().mockResolvedValue([trialing]) });
    mockCancelSubscription.mockRejectedValue(new Error('provider down'));

    const req = mockReq({ params: { orgId: 'org-9' }, user: { organizationId: 'sys-org', sub: 'sysadmin-1' } });
    const res = mockRes();
    await handler(req, res);

    // Provider failure is swallowed; the local delete still runs and the route
    // returns 200 (not 500).
    expect(mockSubscriptionDeleteMany).toHaveBeenCalledWith({ orgId: 'org-9' });
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({ deleted: 1 }));
  });
});

describe('POST /subscriptions/:id/reactivate', () => {
  const handler = getHandler('post', '/subscriptions/:id/reactivate');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
  });

  it('reactivates a canceled subscription', async () => {
    const sub = makeSubscription({ cancelAtPeriodEnd: true });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockReactivateSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(sub.cancelAtPeriodEnd).toBe(false);
    expect(sub.save).toHaveBeenCalled();
    expect(mockReactivateSubscription).toHaveBeenCalledWith('ext-sub-1');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      message: expect.stringContaining('reactivated'),
    }));
  });

  it('returns 404 when no canceled subscription found', async () => {
    mockSubscriptionFindOne.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, expect.stringContaining('No canceled subscription'), 'NOT_FOUND');
  });

  it('returns 500 on provider error', async () => {
    const sub = makeSubscription({ cancelAtPeriodEnd: true });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockReactivateSubscription.mockRejectedValue(new Error('Network error'));

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Internal server error', 'INTERNAL_ERROR');
  });
});
