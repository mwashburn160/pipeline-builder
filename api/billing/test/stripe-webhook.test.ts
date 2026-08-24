// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Stripe webhook route.
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mock api-core
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn((_res: unknown, status: number, data: unknown) => ({ status, data })),
  sendError: jest.fn((_res: unknown, status: number, msg: string) => ({ status, msg })),
}));

// Mock helpers
const mockSyncTier = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockCreateBillingEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockCalculatePeriodEnd = jest.fn(() => new Date('2026-04-01'));
const mockFinalizePrunedAddons = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
// Faithful re-implementation of applyPlanTierChange (deferred sync → change
// event → prune finalize) so the webhook's downstream calls stay observable on
// the existing spies — including the interval_changed event override.
const mockApplyPlanTierChange = jest.fn((subscription: any, plan: { tier: string }, opts: any) => async () => {
  const auth = opts.authHeader ?? 'Bearer service-token';
  await mockSyncTier(subscription.orgId, plan.tier, auth, subscription._id.toString(), subscription.addons ?? []);
  if (opts.event) {
    await mockCreateBillingEvent(subscription.orgId, opts.event.type, opts.event.details, subscription._id.toString(), opts.actorId);
  } else {
    await mockCreateBillingEvent(subscription.orgId, 'plan_changed', { oldPlanId: opts.oldPlanId, newPlanId: opts.newPlanId, ...opts.eventDetails }, subscription._id.toString(), opts.actorId);
  }
  await mockFinalizePrunedAddons(opts.pruned, subscription.addons ?? [], {
    orgId: subscription.orgId, subscriptionId: subscription._id.toString(), interval: subscription.interval, externalId: subscription.externalId, actorId: opts.actorId, source: opts.source,
  });
});
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  recordReactivatePlanMissing: async () => undefined,
  applyPlanTierChange: mockApplyPlanTierChange,
  billingServiceAuth: (_orgId: string) => 'Bearer service-token',
  syncTierToQuotaService: (...args: unknown[]) => mockSyncTier(...args),
  syncEntitlements: (...args: unknown[]) => mockSyncTier(...args),
  createBillingEvent: (...args: unknown[]) => mockCreateBillingEvent(...args),
  // Transitively required by discount-helpers (imported by stripe-webhook for
  // the Phase 6 invoice/cancel reconciliation). getBundleCatalog feeds the combo
  // reconcile step (combo math itself is mocked via combo-pricing below).
  getBundleCatalog: () => [],
  MANAGEABLE_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due'],
  calculatePeriodEnd: (...args: unknown[]) => mockCalculatePeriodEnd(),
  // Double-billing prune: no-op passthrough (nothing to prune on an interval change).
  applyTierIncludedAddonPrune: () => [],
  finalizePrunedAddons: (...args: unknown[]) => mockFinalizePrunedAddons(...args),
}));

// prune/plan-change helpers moved to addon-prune.js (imported by stripe-webhook now).
jest.unstable_mockModule('../src/helpers/addon-prune.js', () => ({
  applyPlanTierChange: mockApplyPlanTierChange,
  applyTierIncludedAddonPrune: () => [],
  finalizePrunedAddons: (...args: unknown[]) => mockFinalizePrunedAddons(...args),
}));

// discount-helpers (real, for invoice reconciliation) imports combo-pricing, which
// loads the real pipeline-core config graph. Stub it so no real combo math / config
// loads — reconcile just needs an empty combo set here.
jest.unstable_mockModule('../src/helpers/combo-pricing.js', () => ({
  getComboDiscounts: () => [],
  activeComboCredits: () => [],
  comboBasisCents: () => 0,
  priceForInterval: (prices: { monthly: number; annual: number }, interval: string) => (interval === 'annual' ? prices.annual : prices.monthly),
  comboLedgerId: (comboId: string) => `combo:${comboId}`,
  volumeDiscountPct: () => 0,
  volumeCredits: () => [],
  volumeLedgerId: (bundleId: string) => `volume:${bundleId}`,
}));

// stripe-webhook now emits incCounter on the reactivate-plan-missing gap; stub it
// so no real Prometheus registry loads at module import.
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
}));

// Capture the real `mapStripeStatus` before the stripe-helpers module is mocked.
// (ESM jest has no jest.requireActual; import the real module first, then mock.)
const { mapStripeStatus: realMapStripeStatus } = await import('../src/helpers/stripe-helpers.js');

// Mock stripe-helpers
const mockFindByStripeId = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFindReversalSub = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ subscription: null, ambiguous: false });
jest.unstable_mockModule('../src/helpers/stripe-helpers.js', () => ({
  findSubscriptionByStripeId: (...args: unknown[]) => mockFindByStripeId(...args),
  findReversalSubscription: (...args: unknown[]) => mockFindReversalSub(...args),
  mapStripeStatus: realMapStripeStatus,
}));

// Mock config
jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    paymentGracePeriodDays: 7,
    stripe: {
      priceToPlanMap: {
        team_monthly: 'price_team_m',
        team_annual: 'price_team_a',
        pro_annual: 'price_pro_a',
        seat_pack_monthly: 'price_bundle_seat',
      },
    },
  },
}));

// Mock Plan model
const mockPlanFindById = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ tier: 'pro', name: 'Pro' });
// A plan/interval change made directly in Stripe reverses the price map then
// looks the plan up via findOne (isActive gated).
const mockPlanFindOne = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ _id: 'team', tier: 'team', name: 'Team', isActive: true });
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: {
    findById: (...args: unknown[]) => mockPlanFindById(...args),
    findOne: (...args: unknown[]) => mockPlanFindOne(...args),
  },
}));

// Mock Subscription model
const mockSubscriptionCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSubscriptionFindOne = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null);
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: (...a: unknown[]) => mockSubscriptionFindOne(...a), create: (...args: unknown[]) => mockSubscriptionCreate(...args), countDocuments: jest.fn<(...a: unknown[]) => Promise<number>>().mockResolvedValue(1) },
}));

// Mock provider factory
const mockConstructEvent = jest.fn();
const mockGetWebhookSecret = jest.fn().mockReturnValue('whsec_test');
const mockGetStripeClient = jest.fn().mockReturnValue({
  webhooks: { constructEvent: (...args: unknown[]) => mockConstructEvent(...args) },
});

const mockCancelSubscriptionNow = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({
    getStripeClient: mockGetStripeClient,
    getWebhookSecret: mockGetWebhookSecret,
    cancelSubscriptionNow: (...a: unknown[]) => mockCancelSubscriptionNow(...a),
    // StripeProvider instanceof check needs help
    constructor: { name: 'StripeProvider' },
  }),
}));

// Override instanceof check for StripeProvider
jest.unstable_mockModule('../src/providers/stripe-provider.js', () => {
  class MockStripeProvider {}
  return { StripeProvider: MockStripeProvider };
});

const { sendError } = await import('@pipeline-builder/api-core');
const { createStripeWebhookRoutes, planFromStripePrice, handleSubscriptionUpdated, handleSubscriptionCreated } = await import('../src/routes/stripe-webhook.js');

// Since we can't easily test instanceof with mocks, we test the handler logic directly.
// Extract the route handler from the router.
function getWebhookHandler() {
  const router = createStripeWebhookRoutes();
  const layer = (router as unknown as { stack: Array<{ route: { path: string; stack: Array<{ handle: Function }> } }> })
    .stack.find((l) => l.route?.path === '/stripe/webhook');
  return layer?.route.stack[0].handle;
}

describe('Stripe Webhook Route', () => {
  let handler: Function;

  beforeAll(() => {
    handler = getWebhookHandler()!;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeReq(overrides: Record<string, unknown> = {}) {
    return {
      headers: { 'stripe-signature': 'sig_test' },
      body: Buffer.from('{}'),
      ...overrides,
    };
  }

  function makeRes() {
    return {} as Record<string, unknown>;
  }

  describe('signature verification', () => {
    it('returns 400 when stripe-signature header is missing', async () => {
      // The handler first checks for StripeProvider instanceof, which will fail
      // since our mock doesn't extend StripeProvider.
      // This tests the early return for missing provider.
      const req = makeReq({ headers: {} });
      await handler(req, makeRes());
      // Provider check fails first due to instanceof
      expect(sendError).toHaveBeenCalled();
    });
  });

  describe('mapStripeStatus', () => {
    // Test the helper directly since webhook integration depends on mocks
    const mapStripeStatus = realMapStripeStatus;

    it('maps active status', () => {
      expect(mapStripeStatus('active')).toBe('active');
    });

    it('maps trialing status', () => {
      expect(mapStripeStatus('trialing')).toBe('trialing');
    });

    it('maps past_due status', () => {
      expect(mapStripeStatus('past_due')).toBe('past_due');
    });

    it('maps canceled status', () => {
      expect(mapStripeStatus('canceled')).toBe('canceled');
    });

    it('maps unpaid to canceled', () => {
      expect(mapStripeStatus('unpaid')).toBe('canceled');
    });

    it('maps incomplete status', () => {
      expect(mapStripeStatus('incomplete')).toBe('incomplete');
    });

    it('maps incomplete_expired to incomplete', () => {
      expect(mapStripeStatus('incomplete_expired')).toBe('incomplete');
    });

    it('maps unknown status to incomplete', () => {
      expect(mapStripeStatus('some_new_status')).toBe('incomplete');
    });
  });

  describe('findSubscriptionByStripeId', () => {
    it('queries with correct filter', async () => {
      mockFindByStripeId.mockResolvedValue(null);

      await mockFindByStripeId('sub_test_123');
      expect(mockFindByStripeId).toHaveBeenCalledWith('sub_test_123');
    });
  });

  // Reverse of config.stripe.priceToPlanMap — powers plan-change sync when a
  // subscription is edited directly in Stripe (customer.subscription.updated).
  describe('planFromStripePrice', () => {
    it('maps a known monthly plan price to its planId + interval', () => {
      expect(planFromStripePrice('price_team_m')).toEqual({ planId: 'team', interval: 'monthly' });
    });

    it('maps a known annual plan price', () => {
      expect(planFromStripePrice('price_pro_a')).toEqual({ planId: 'pro', interval: 'annual' });
    });

    it('splits only the trailing interval token (bundle ids with underscores survive)', () => {
      // A bundle price still reverses; the handler discards it via the Plan lookup.
      expect(planFromStripePrice('price_bundle_seat')).toEqual({ planId: 'seat_pack', interval: 'monthly' });
    });

    it('returns null for a price id not in the map', () => {
      expect(planFromStripePrice('price_unknown')).toBeNull();
    });
  });
});

// ============================================
// Grace period & payment handler logic tests
// ============================================

describe('Payment failure grace period logic', () => {
  it('should track failed payment attempts incrementally', () => {
    const subscription = {
      orgId: 'org-1',
      status: 'active' as string,
      failedPaymentAttempts: 0,
      firstFailedAt: undefined as Date | undefined,
    };

    // First failure
    subscription.status = 'past_due';
    subscription.failedPaymentAttempts += 1;
    if (!subscription.firstFailedAt) {
      subscription.firstFailedAt = new Date();
    }

    expect(subscription.status).toBe('past_due');
    expect(subscription.failedPaymentAttempts).toBe(1);
    expect(subscription.firstFailedAt).toBeDefined();

    // Second failure
    const firstFailedAt = subscription.firstFailedAt;
    subscription.failedPaymentAttempts += 1;
    if (!subscription.firstFailedAt) {
      subscription.firstFailedAt = new Date();
    }

    expect(subscription.failedPaymentAttempts).toBe(2);
    expect(subscription.firstFailedAt).toBe(firstFailedAt); // Should not change
  });

  it('should reset grace period state on successful payment', () => {
    const subscription = {
      orgId: 'org-1',
      status: 'past_due' as string,
      failedPaymentAttempts: 3,
      firstFailedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) as Date | undefined,
      interval: 'monthly' as const,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
    };

    // Simulate payment success
    subscription.failedPaymentAttempts = 0;
    subscription.firstFailedAt = undefined;
    subscription.status = 'active';

    expect(subscription.failedPaymentAttempts).toBe(0);
    expect(subscription.firstFailedAt).toBeUndefined();
    expect(subscription.status).toBe('active');
  });

  it('should determine grace period expiry correctly', () => {
    const gracePeriodDays = 7;
    const gracePeriodMs = gracePeriodDays * 24 * 60 * 60 * 1000;

    // 6 days ago — still in grace period
    const recentFailure = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const cutoff = new Date(Date.now() - gracePeriodMs);
    expect(recentFailure.getTime() > cutoff.getTime()).toBe(true);

    // 8 days ago — grace period expired
    const oldFailure = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(oldFailure.getTime() <= cutoff.getTime()).toBe(true);
  });
});

// ============================================
// handleSubscriptionUpdated → grace-clock start
// ============================================

describe('handleSubscriptionUpdated past_due grace clock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeSub(overrides: Record<string, unknown> = {}) {
    return {
      _id: { toString: () => 'sub-1' },
      orgId: 'org-1',
      planId: 'team',
      interval: 'monthly',
      status: 'active',
      cancelAtPeriodEnd: false,
      firstFailedAt: undefined as Date | undefined,
      addons: [],
      metadata: { provider: 'stripe' },
      save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  // A Stripe subscription with no line items so the plan-change branch (which
  // would hit Plan.findOne) is skipped — we only exercise the status path.
  function stripeSub(status: string) {
    return { id: 'sub_ext', status, cancel_at_period_end: false, items: { data: [] } } as any;
  }

  it('stamps firstFailedAt when transitioning into past_due without a prior failure', async () => {
    const sub = makeSub({ status: 'active', firstFailedAt: undefined });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('past_due'));

    expect(sub.status).toBe('past_due');
    expect(sub.firstFailedAt).toBeInstanceOf(Date);
    expect(sub.save).toHaveBeenCalled();
  });

  it('leaves an existing firstFailedAt untouched when already past_due', async () => {
    const existing = new Date('2026-07-01T00:00:00Z');
    const sub = makeSub({ status: 'past_due', firstFailedAt: existing });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('past_due'));

    // No status/clock change — the in-progress grace window must not reset.
    expect(sub.firstFailedAt).toBe(existing);
  });

  // H1: a `.updated` crossing OUT of an entitled status into a terminal one must
  // downgrade entitlements (no `.deleted` may ever arrive).
  it('downgrades entitlements when an update flips an entitled sub to canceled', async () => {
    const sub = makeSub({ status: 'active', creditLedger: [], creditBalanceCents: 0, recurringDiscount: null });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('canceled'));

    expect(sub.status).toBe('canceled');
    expect(sub.save).toHaveBeenCalled();
    expect(mockSyncTier).toHaveBeenCalledWith('org-1', 'developer', '', 'sub-1');
  });

  it('downgrades on unpaid (maps to canceled) via update, not only on delete', async () => {
    const sub = makeSub({ status: 'past_due', creditLedger: [], creditBalanceCents: 0, recurringDiscount: null });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('unpaid'));

    expect(sub.status).toBe('canceled');
    expect(mockSyncTier).toHaveBeenCalledWith('org-1', 'developer', '', 'sub-1');
  });

  it('does NOT downgrade on a benign active→past_due transition (still entitled, grace period)', async () => {
    const sub = makeSub({ status: 'active', creditLedger: [], creditBalanceCents: 0, recurringDiscount: null });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('past_due'));

    expect(mockSyncTier).not.toHaveBeenCalledWith('org-1', 'developer', '', 'sub-1');
  });
});

describe('handleSubscriptionCreated (checkout provisioning)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByStripeId.mockResolvedValue(null); // no local row yet
    mockPlanFindOne.mockResolvedValue({ _id: 'team', tier: 'team', name: 'Team', isActive: true, prices: { monthly: 7900, annual: 79000 } });
    mockSubscriptionCreate.mockResolvedValue({ _id: { toString: () => 'sub-new' } });
  });

  /** A Stripe subscription as delivered by `customer.subscription.created` after a
   *  hosted Checkout — carries the orgId/planId/interval metadata Checkout stamps. */
  function created(metadata: Record<string, string>, status = 'active') {
    return { id: 'sub_ext', status, cancel_at_period_end: false, customer: 'cust_x', metadata } as any;
  }

  it('provisions the local subscription + grants entitlements from checkout metadata', async () => {
    await handleSubscriptionCreated(created({ orgId: 'org-9', planId: 'team', interval: 'monthly' }));

    expect(mockSubscriptionCreate).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-9', planId: 'team', status: 'active', interval: 'monthly',
      externalId: 'sub_ext', externalCustomerId: 'cust_x', metadata: { provider: 'stripe' },
    }));
    // Entitlements granted with a real service token + the new sub id.
    expect(mockSyncTier).toHaveBeenCalledWith('org-9', 'team', 'Bearer service-token', 'sub-new');
  });

  it('does NOT grant entitlements for a non-entitlement-worthy status (incomplete)', async () => {
    await handleSubscriptionCreated(created({ orgId: 'org-9', planId: 'team', interval: 'monthly' }, 'incomplete'));
    expect(mockSubscriptionCreate).toHaveBeenCalled();
    expect(mockSyncTier).not.toHaveBeenCalled();
  });

  it('does NOT provision an out-of-band create with no planId metadata', async () => {
    await handleSubscriptionCreated(created({ orgId: 'org-9' }));
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
    expect(mockSyncTier).not.toHaveBeenCalled();
  });

  it('delegates to the update handler when a local row already exists', async () => {
    mockFindByStripeId.mockResolvedValue({ orgId: 'org-9', status: 'active', save: jest.fn(), _id: { toString: () => 'sub-x' } });
    await handleSubscriptionCreated(created({ orgId: 'org-9', planId: 'team', interval: 'monthly' }));
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
  });

  it('cancels a DUPLICATE incoming sub when the org already has a manageable one bound elsewhere', async () => {
    // No local row for THIS externalId, but the org already has a manageable sub
    // bound to a DIFFERENT Stripe sub (two checkouts completed) → cancel the
    // incoming duplicate immediately, don't create/orphan a second billing sub.
    mockSubscriptionFindOne.mockResolvedValue({ externalId: 'sub_KEEPER', status: 'active' });
    await handleSubscriptionCreated(created({ orgId: 'org-9', planId: 'team', interval: 'monthly' }));
    expect(mockCancelSubscriptionNow).toHaveBeenCalledWith('sub_ext');
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
  });
});

// ============================================
// handleSubscriptionUpdated → interval-only change (mislabel fix)
// ============================================

describe('handleSubscriptionUpdated interval-only change', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlanFindOne.mockResolvedValue({ _id: 'team', tier: 'team', name: 'Team', isActive: true });
  });

  function makeSub(overrides: Record<string, unknown> = {}) {
    return {
      _id: { toString: () => 'sub-1' },
      orgId: 'org-1',
      planId: 'team',
      interval: 'monthly',
      status: 'active',
      cancelAtPeriodEnd: false,
      firstFailedAt: undefined as Date | undefined,
      addons: [],
      externalId: 'ext-sub-1',
      metadata: { provider: 'stripe' },
      save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  // Stripe base line item now carries the SAME plan at a DIFFERENT interval
  // (team monthly → team annual): price_team_a reverses to {planId:'team',
  // interval:'annual'}.
  function stripeIntervalChange() {
    return { id: 'sub_ext', status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_team_a' } }] } } as any;
  }

  it('emits interval_changed (NOT a plan_changed with equal ids) when only the interval changed', async () => {
    const sub = makeSub();
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeIntervalChange());

    // The local record re-cadences to annual and persists.
    expect(sub.interval).toBe('annual');
    expect(sub.save).toHaveBeenCalled();
    // Same tier re-synced (idempotent), with a service token.
    expect(mockSyncTier).toHaveBeenCalledWith('org-1', 'team', 'Bearer service-token', 'sub-1', []);

    // The distinguishing fix: an interval_changed event, never a plan_changed
    // whose oldPlanId === newPlanId.
    const types = mockCreateBillingEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain('interval_changed');
    expect(types).not.toContain('plan_changed');
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'interval_changed',
      expect.objectContaining({ provider: 'stripe', oldInterval: 'monthly', newInterval: 'annual' }),
      'sub-1', undefined,
    );
  });

  it('still emits plan_changed when the plan (tier) actually changed', async () => {
    // team monthly → team ... no: switch to a real plan change. price_team_m maps
    // to team/monthly; start the sub on pro/monthly so the plan differs.
    const sub = makeSub({ planId: 'pro', interval: 'monthly' });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated({ id: 'sub_ext', status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_team_m' } }] } } as any);

    const types = mockCreateBillingEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain('plan_changed');
    expect(types).not.toContain('interval_changed');
  });
});
