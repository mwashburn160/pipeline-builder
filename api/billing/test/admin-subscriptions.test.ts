// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/admin-subscriptions.
 *
 * Tests admin billing routes by extracting handlers from the router.
 * Mocks Mongoose models, billing helpers, and api-core utilities.
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
  isSystemAdmin: mockIsSystemAdmin,
  requireSystemAdmin: (_req: any, _res: any, next: () => void) => next(),
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  getServiceAuthHeader: jest.fn(() => 'Bearer service-token'),
  parseQueryInt: jest.fn((_val: unknown, defaultVal: number) => defaultVal),
  parseQueryIntClamped: jest.fn((val: unknown, def: number, max: number) => {
    const raw = val === undefined ? def : parseInt(String(val), 10);
    const n = Number.isFinite(raw) ? raw : def;
    return Math.max(1, Math.min(n, max));
  }),
  parseQueryString: jest.fn((_val: unknown) => undefined as string | undefined),
  validateBody: mockValidateBody,
}));

const mockSubscriptionFind = jest.fn<(...args: unknown[]) => any>();
const mockSubscriptionFindById = jest.fn<(...args: unknown[]) => any>();
const mockSubscriptionCountDocuments = jest.fn<(...args: unknown[]) => Promise<number>>();

jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    find: mockSubscriptionFind,
    findById: mockSubscriptionFindById,
    countDocuments: mockSubscriptionCountDocuments,
  },
}));

const mockPlanFindOne = jest.fn<(...args: unknown[]) => any>();
const mockPlanFindById = jest.fn<(...args: unknown[]) => any>();

jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findOne: mockPlanFindOne, findById: mockPlanFindById },
}));

const mockBillingEventFind = jest.fn<(...args: unknown[]) => any>();
const mockBillingEventCountDocuments = jest.fn<(...args: unknown[]) => Promise<number>>();

jest.unstable_mockModule('../src/models/billing-event.js', () => ({
  BillingEvent: {
    find: mockBillingEventFind,
    countDocuments: mockBillingEventCountDocuments,
  },
}));

const mockBuildSubscriptionResponse = jest.fn((sub: any) => ({
  id: sub._id?.toString() || sub.id,
  orgId: sub.orgId,
  planId: sub.planId,
  status: sub.status,
}));
const mockSyncTierToQuotaService = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockCreateBillingEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockRecordReactivate = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
// Double-billing prune: default no-op (returns []). applyTierIncludedAddonPrune
// mutates subscription.addons in place; a dedicated test overrides it.
const mockApplyTierIncludedAddonPrune = jest.fn(
  (_sub: { addons?: Array<{ bundleId: string; quantity: number }> }) => [] as Array<{ bundleId: string; features: string[] }>,
);
// finalizePrunedAddons owns the post-save provider removal + audit; the route wires
// it. We assert the call shape here and unit-test the provider removal elsewhere.
const mockFinalizePrunedAddons = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
// Faithful re-implementation of the real applyPlanTierChange (deferred
// sync → plan_changed event → prune finalize) so the route's downstream calls
// stay observable on the existing spies. The admin route's own
// billing.tier.override central-audit record stays inline (asserted separately).
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
  recordReactivatePlanMissing: (...a: unknown[]) => mockRecordReactivate(...a),
  applyPlanTierChange: mockApplyPlanTierChange,
  billingServiceAuth: (_orgId: string) => 'Bearer service-token',
  buildSubscriptionResponse: mockBuildSubscriptionResponse,
  syncTierToQuotaService: mockSyncTierToQuotaService,
  syncEntitlements: mockSyncTierToQuotaService,
  syncProviderAddons: jest.fn(async () => undefined),
  createBillingEvent: mockCreateBillingEvent,
  applyTierIncludedAddonPrune: mockApplyTierIncludedAddonPrune,
  finalizePrunedAddons: mockFinalizePrunedAddons,
  // Entitled (paid-tier-enforcing) status set the route reads to decide whether
  // an admin status flip crosses the entitlement boundary.
  MANAGEABLE_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due'],
}));

// prune/plan-change helpers moved to addon-prune.js (imported by the route now).
jest.unstable_mockModule('../src/helpers/addon-prune.js', () => ({
  applyPlanTierChange: mockApplyPlanTierChange,
  applyTierIncludedAddonPrune: mockApplyTierIncludedAddonPrune,
  finalizePrunedAddons: mockFinalizePrunedAddons,
}));

// Payment provider — an admin plan change must push the new price to the
// provider (provider-first), mirroring the user-facing PUT /subscriptions/:id.
const mockUpdateSubscription = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({
    updateSubscription: mockUpdateSubscription,
  }),
}));

jest.unstable_mockModule('../src/validation/schemas.js', () => ({
  AdminSubscriptionUpdateSchema: {},
}));

// Central-trail audit client — the tier override emits billing.tier.override
// here ALONGSIDE the local billing_events write. Mock it to assert emission.
const mockAuditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  getAuditClient: () => ({ record: mockAuditRecord }),
}));

const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  withRoute: (handler: any, _opts?: any) => async (req: any, res: any) => {
    const ctx = {
      identity: { orgId: req.user?.organizationId, userId: req.user?.sub },
      log: jest.fn(),
    };
    const orgId = req.user?.organizationId || '';
    const userId = req.user?.sub || '';
    try {
      await handler({ req, res, ctx, orgId, userId });
    } catch (err: any) {
      mockSendError(res, 500, err.message || 'Internal server error');
    }
  },
}));

const { createAdminSubscriptionRoutes } = await import('../src/routes/admin-subscriptions.js');

const router = createAdminSubscriptionRoutes();

// Helpers

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    headers: { authorization: 'Bearer tok' },
    user: { organizationId: 'org-1', sub: 'admin-1' },
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
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Tests

describe('GET /admin/subscriptions', () => {
  const handler = getHandler('get', '/admin/subscriptions');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
  });

  it('lists all subscriptions', async () => {
    const subs = [makeSubscription()];
    mockSubscriptionFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(subs),
          }),
        }),
      }),
    });
    mockSubscriptionCountDocuments.mockResolvedValue(1);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      subscriptions: expect.any(Array),
      total: 1,
    }));
  });

  it('returns 500 on database error', async () => {
    mockSubscriptionFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      }),
    });
    mockSubscriptionCountDocuments.mockResolvedValue(0);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });
});

describe('PUT /admin/subscriptions/:id', () => {
  const handler = getHandler('put', '/admin/subscriptions/:id');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
  });

  it('updates subscription plan and logs billing event', async () => {
    const sub = makeSubscription({ planId: 'developer' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro' } });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      subscription: expect.any(Object),
    }));
    // The acting sysadmin (req.user.sub) is attributed as the actorId (5th arg).
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'plan_changed',
      { oldPlanId: 'developer', newPlanId: 'pro' },
      'sub-1', 'admin-1',
    );
    expect(mockSyncTierToQuotaService).toHaveBeenCalled();
  });

  it('pushes the new plan price to the provider on a Stripe-backed sub (no finance drift)', async () => {
    // A Stripe-backed sub (has externalId) must have its price re-pushed so the
    // provider stops invoicing the OLD plan while the org receives the NEW tier's
    // entitlements — mirroring the user-facing PUT /subscriptions/:id.
    const sub = makeSubscription({ planId: 'developer', interval: 'monthly', externalId: 'ext-stripe-1' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    // New plan pushed with the current (unchanged) cadence.
    expect(mockUpdateSubscription).toHaveBeenCalledWith('ext-stripe-1', 'pro', 'monthly');
    // Entitlements still sync (billing + entitlements stay consistent).
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'pro', 'Bearer service-token', 'sub-1', []);
  });

  it('pushes the effective interval when an admin changes plan AND interval together', async () => {
    // A combined plan+interval override must land on `{newPlan}_{newInterval}`, so
    // the provider re-cadences AND re-prices in one push (matches the user path's
    // effective-cadence behavior).
    const sub = makeSubscription({ planId: 'developer', interval: 'monthly', externalId: 'ext-stripe-2' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro', interval: 'annual' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockUpdateSubscription).toHaveBeenCalledWith('ext-stripe-2', 'pro', 'annual');
  });

  it('skips the provider push for a marketplace / no-externalId sub (nothing to push)', async () => {
    // A not-yet-externally-bound row (no externalId) has no provider price to
    // push; the route skips the provider call cleanly and only syncs entitlements.
    const sub = makeSubscription({ planId: 'developer' }); // no externalId
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    // Entitlement sync still happens — only the provider push is skipped.
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'pro', 'Bearer service-token', 'sub-1', []);
  });

  it('aborts before save/sync when the provider price push fails (provider-first drift guard)', async () => {
    // Mirror the user path's failure contract: provider-first means a provider
    // failure throws BEFORE the doc is saved and entitlements sync, so billing and
    // entitlements never diverge (nothing persisted to revert).
    const sub = makeSubscription({ planId: 'developer', externalId: 'ext-stripe-3' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro' } });
    mockUpdateSubscription.mockRejectedValueOnce(new Error('stripe price push failed'));

    const res = mockRes();
    await handler(mockReq({ params: { id: 'sub-1' } }), res);

    // Provider threw → nothing persisted or synced, and the error surfaces.
    expect(sub.save).not.toHaveBeenCalled();
    expect(mockSyncTierToQuotaService).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'stripe price push failed');
  });

  it('updates status and logs subscription_updated event with the providerUntouched note (admin override trust boundary)', async () => {
    const sub = makeSubscription({ status: 'active' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { status: 'canceled' } });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    // active→canceled crosses INTO a terminal status: the row is tagged
    // providerUntouched:true so finance can see provider billing was deliberately
    // left running (admin override does NOT call provider.cancelSubscription).
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      { status: 'canceled', providerUntouched: true },
      'sub-1', 'admin-1',
    );
  });

  it('does NOT tag providerUntouched on an entitled→entitled status change', async () => {
    // active→trialing stays entitled (no terminal crossing) → no providerUntouched note.
    const sub = makeSubscription({ status: 'active', planId: 'pro' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { status: 'trialing' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated', { status: 'trialing' }, 'sub-1', 'admin-1',
    );
  });

  it('reactivation with a missing plan writes a WARN billing_events row + metric and does NOT sync (Fix 2)', async () => {
    // canceled→active crosses into an entitled status, but the subscription's
    // planId points at a deleted/missing plan: without the else-branch the org
    // would silently get no sync/event. Assert the observable gap instead.
    const sub = makeSubscription({ status: 'canceled', planId: 'ghost-plan', addons: [] });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindById.mockResolvedValue(null);
    mockValidateBody.mockReturnValue({ ok: true, value: { status: 'active' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    // No entitlement sync fired (no tier to grant).
    expect(mockSyncTierToQuotaService).not.toHaveBeenCalled();
    // The shared reactivate-plan-missing recorder captures the gap (event + metric
    // live in that helper now) with the admin source + context.
    expect(mockRecordReactivate).toHaveBeenCalledWith(
      'org-1', 'sub-1', 'admin',
      { status: 'active', planId: 'ghost-plan' },
      'admin-1',
    );
  });

  it('downgrades entitlements to the baseline tier when admin cancels (status → canceled)', async () => {
    // active (entitled) → canceled (terminal) crosses the entitlement boundary,
    // so the account must fall back to the developer baseline with add-ons cleared
    // — mirroring the normal cancel / grace-expiry downgrade. Without this the
    // quota/platform stores keep enforcing the paid tier (and the drift reconciler
    // silently re-syncs it back up).
    const sub = makeSubscription({ status: 'active', planId: 'pro', addons: [{ bundleId: 'seat_pack', quantity: 2 }] });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { status: 'canceled' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    // Baseline tier + EMPTY add-ons, via a service token (never the admin bearer).
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'developer', 'Bearer service-token', 'sub-1', []);
  });

  it('downgrades to baseline when admin sets a terminal incomplete status', async () => {
    const sub = makeSubscription({ status: 'active', planId: 'team' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { status: 'incomplete' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'developer', 'Bearer service-token', 'sub-1', []);
  });

  it('re-syncs the current plan tier + add-ons when admin reactivates (status → active)', async () => {
    // canceled (terminal) → active (entitled) crosses the boundary the other way:
    // re-enforce the subscription's CURRENT plan tier + purchased add-ons, mirroring
    // the webhook payment-recovery / reactivate re-upgrade.
    const addons = [{ bundleId: 'seat_pack', quantity: 3 }];
    const sub = makeSubscription({ status: 'canceled', planId: 'team', addons });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindById.mockResolvedValue({ _id: 'team', name: 'Team', tier: 'team', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { status: 'active' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockPlanFindById).toHaveBeenCalledWith('team');
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'team', 'Bearer service-token', 'sub-1', addons);
  });

  it('does NOT sync entitlements for an entitled→entitled status change (guard against over-syncing)', async () => {
    // active → trialing: both are entitlement-worthy, so enforcement is unchanged
    // and no re-sync should fire (avoids churning the quota/platform stores).
    const sub = makeSubscription({ status: 'active', planId: 'pro' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { status: 'trialing' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockSyncTierToQuotaService).not.toHaveBeenCalled();
    // The billing_events row is still written (status did change).
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated', { status: 'trialing' }, 'sub-1', 'admin-1',
    );
  });

  it('does NOT sync entitlements when a plan change already handles a reactivation (no double-sync)', async () => {
    // Admin flips canceled→active AND changes the plan: the plan block owns the
    // entitled sync (new tier + add-ons); the status block must NOT re-sync.
    const sub = makeSubscription({ status: 'canceled', planId: 'developer' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro', status: 'active' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    // Exactly one sync — from the plan block (new tier), not a second from status.
    expect(mockSyncTierToQuotaService).toHaveBeenCalledTimes(1);
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'pro', 'Bearer service-token', 'sub-1', []);
    // The status-block reactivation branch never looks up the current plan.
    expect(mockPlanFindById).not.toHaveBeenCalled();
  });

  it('updates interval and logs interval_changed event', async () => {
    const sub = makeSubscription({ interval: 'monthly' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { interval: 'annual' } });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'interval_changed',
      { oldInterval: 'monthly', newInterval: 'annual' },
      'sub-1', 'admin-1',
    );
  });

  it('attributes the override to the acting sysadmin (actorId = caller sub)', async () => {
    const sub = makeSubscription({ planId: 'developer' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro' } });

    // A DIFFERENT admin than the default — proves the actorId is threaded from
    // the request, not hardcoded.
    const req = mockReq({ params: { id: 'sub-1' }, user: { organizationId: 'org-1', sub: 'sysadmin-42' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'plan_changed',
      { oldPlanId: 'developer', newPlanId: 'pro' },
      'sub-1', 'sysadmin-42',
    );
  });

  it('prunes a tier-included add-on and removes the provider line item post-save (double-billing fix)', async () => {
    const sub = makeSubscription({
      planId: 'pro',
      interval: 'monthly',
      externalId: 'ext-admin-1',
      addons: [{ bundleId: 'audit_log', quantity: 1 }, { bundleId: 'seat_pack', quantity: 2 }],
    });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'team', name: 'Team', tier: 'team', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'team' } });

    // team bundles in audit_log → dropped; the quota pack (seat_pack) is retained.
    const reduced = [{ bundleId: 'seat_pack', quantity: 2 }];
    const pruned = [{ bundleId: 'audit_log', features: ['audit_log'] }];
    mockApplyTierIncludedAddonPrune.mockImplementationOnce((s: any) => { s.addons = reduced; return pruned; });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(sub.addons).toEqual(reduced);
    expect(sub.save).toHaveBeenCalled();
    // Deferred (post-save): the reduced set syncs + the provider removal fires
    // with the pruned bundle, reduced list, and the sub's external id / cadence.
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'team', 'Bearer service-token', 'sub-1', reduced);
    expect(mockFinalizePrunedAddons).toHaveBeenCalledWith(
      pruned,
      reduced,
      expect.objectContaining({
        orgId: 'org-1',
        subscriptionId: 'sub-1',
        interval: 'monthly',
        externalId: 'ext-admin-1',
        actorId: 'admin-1',
      }),
    );
  });

  it('does NOT finalize a prune when subscription.save() rejects (drift guard)', async () => {
    const sub = makeSubscription({
      planId: 'developer',
      addons: [{ bundleId: 'audit_log', quantity: 1 }],
      save: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('write conflict')),
    });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'team', name: 'Team', tier: 'team', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'team' } });
    mockApplyTierIncludedAddonPrune.mockImplementationOnce((s: any) => { s.addons = []; return [{ bundleId: 'audit_log', features: ['audit_log'] }]; });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    // save() threw → the deferred queue never ran, so no provider removal / trail.
    expect(mockFinalizePrunedAddons).not.toHaveBeenCalled();
  });

  it('fires NO side effects when subscription.save() rejects (drift guard)', async () => {
    const sub = makeSubscription({
      planId: 'developer',
      save: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('write conflict')),
    });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro', status: 'canceled', interval: 'annual' } });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    // save() threw -> the error surfaces and NOTHING was pushed to the quota
    // service or the billing_events log (no billing<->quota drift).
    expect(sub.save).toHaveBeenCalled();
    expect(mockSyncTierToQuotaService).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'write conflict');
  });

  it('mirrors the tier override to the CENTRAL trail with affectedOrgId = target org', async () => {
    // The subscription belongs to ANOTHER org; the sysadmin acts across tenants.
    const sub = makeSubscription({ planId: 'developer', orgId: 'org-target' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro' } });

    const req = mockReq({ params: { id: 'sub-1' }, user: { organizationId: 'sys-org', sub: 'sysadmin-7' } });
    await handler(req, mockRes());

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.tier.override',
        actorId: 'sysadmin-7',
        affectedOrgId: 'org-target',
        targetId: 'sub-1',
        details: expect.objectContaining({ toTier: 'pro', fromPlanId: 'developer', toPlanId: 'pro' }),
      }),
      'billing',
    );
  });

  it('never emits card/payment secrets or an account id in the override details', async () => {
    const sub = makeSubscription({
      planId: 'developer',
      orgId: 'org-target',
      externalCustomerId: 'cus_LEAKED',
      stripeCustomerId: 'cus_LEAKED',
      awsAccountId: '123456789012',
    });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    const [event] = mockAuditRecord.mock.calls[0];
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('cus_LEAKED');
    expect(serialized).not.toContain('123456789012');
  });

  it('does NOT emit billing.tier.override for a status-only admin change', async () => {
    const sub = makeSubscription({ status: 'active' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { status: 'canceled' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockAuditRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.tier.override' }),
      'billing',
    );
  });

  it('does NOT emit the tier override when subscription.save() rejects (drift guard)', async () => {
    const sub = makeSubscription({
      planId: 'developer',
      save: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('write conflict')),
    });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro' } });

    await handler(mockReq({ params: { id: 'sub-1' } }), mockRes());

    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it('returns 404 when subscription not found', async () => {
    mockSubscriptionFindById.mockResolvedValue(null);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro' } });

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Subscription not found', 'NOT_FOUND');
  });

  it('returns 404 when new plan not found', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue(null);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'nonexistent' } });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Plan not found', 'NOT_FOUND');
  });

  it('returns validation error on bad body', async () => {
    mockValidateBody.mockReturnValue({ ok: false, error: 'Invalid field' });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendBadRequest).toHaveBeenCalledWith(res, 'Invalid field', 'VALIDATION_ERROR');
  });
});

describe('GET /admin/events', () => {
  const handler = getHandler('get', '/admin/events');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
  });

  it('lists billing events', async () => {
    const events = [{
      _id: { toString: () => 'evt-1' },
      orgId: 'org-1',
      subscriptionId: 'sub-1',
      type: 'plan_changed',
      details: {},
      createdAt: new Date('2026-03-01'),
    }];
    mockBillingEventFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(events),
          }),
        }),
      }),
    });
    mockBillingEventCountDocuments.mockResolvedValue(1);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      events: expect.any(Array),
      total: 1,
    }));
  });

  it('returns 500 on database error', async () => {
    mockBillingEventFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      }),
    });
    mockBillingEventCountDocuments.mockResolvedValue(0);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });
});

describe('GET /events (customer-scoped, billing:read)', () => {
  const handler = getHandler('get', '/events');

  it('lists ONLY the caller\'s own org events (never a cross-org ?orgId)', async () => {
    const leanFn = jest.fn().mockResolvedValue([{
      _id: { toString: () => 'evt-9' },
      orgId: 'org-1',
      subscriptionId: 'sub-1',
      type: 'credit_consumed',
      actorId: 'system',
      details: { consumedCents: 2000 },
      createdAt: new Date('2026-07-29'),
    }]);
    mockBillingEventFind.mockReturnValue({ sort: () => ({ skip: () => ({ limit: () => ({ lean: leanFn }) }) }) });
    mockBillingEventCountDocuments.mockResolvedValue(1);

    // A caller trying to widen scope via ?orgId must be ignored — always own org.
    await handler(mockReq({ query: { orgId: 'org-victim' } }), mockRes());

    expect(mockBillingEventFind).toHaveBeenCalledWith({ orgId: 'org-1' });
    expect(mockBillingEventCountDocuments).toHaveBeenCalledWith({ orgId: 'org-1' });
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ total: 1 }));
  });
});
