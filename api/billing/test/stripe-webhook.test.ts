// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Stripe webhook's HANDLERS and the helpers they lean on.
 *
 * The ROUTE itself — signature refusals, the two-phase idempotency claim and
 * the event-type dispatch table — lives in `stripe-webhook-route.test.ts`,
 * which stands up a provider that really is a `StripeProvider`.
 *
 * It has to, and that is why the split exists: the provider double BELOW is a
 * plain object, so the route's `active instanceof StripeProvider` guard is
 * always false and every request stops at the first early return. This suite
 * once carried a "signature verification" test that looked like route coverage
 * and was in fact asserting the provider-not-configured branch — which is how
 * `routes/stripe-webhook.ts` sat at 9% function coverage while appearing
 * tested. The route scaffolding has been removed rather than repaired: the
 * double is exactly right for driving handlers directly, which is all this
 * suite now does.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
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
  billingServiceAuth: (_orgId: string) => 'Bearer service-token',
  createBillingEvent: (...args: unknown[]) => mockCreateBillingEvent(...args),
  // Transitively required by discount-helpers (imported by stripe-webhook for
  // the invoice/cancel reconciliation). getBundleCatalog feeds the combo
  // reconcile step (combo math itself is mocked via combo-pricing below).
  getBundleCatalog: () => [],
  calculatePeriodEnd: () => mockCalculatePeriodEnd(),
}));
jest.unstable_mockModule('../src/helpers/entitlement-sync.js', () => ({
  syncTierToQuotaService: (...args: unknown[]) => mockSyncTier(...args),
  syncEntitlements: (...args: unknown[]) => mockSyncTier(...args),
}));

jest.unstable_mockModule('../src/helpers/addon-prune.js', () => ({
  applyPlanTierChange: mockApplyPlanTierChange,
  applyTierIncludedAddonPrune: () => [],
  finalizePrunedAddons: (...args: unknown[]) => mockFinalizePrunedAddons(...args),
}));

// discount-helpers (real, for invoice reconciliation) imports combo-pricing, which
// loads the real pipeline-core config graph. Stub it so no real combo math / config
// loads — reconcile just needs an empty combo set here.
jest.unstable_mockModule('../src/helpers/combo-pricing.js', () => ({
  // Mirrors the real discountBaseCents: plan price unless a bundle scope is set.
  discountBaseCents: (d: { appliesToBundles?: readonly string[] }, planCents: number) => (d.appliesToBundles?.length ? 0 : planCents),
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
const mockIncCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
}));

// Capture the real `mapStripeStatus` before the stripe-helpers module is mocked.
// (ESM jest has no jest.requireActual; import the real module first, then mock.)
const { mapStripeStatus: realMapStripeStatus } = await import('../src/helpers/stripe-helpers.js');

// Mock stripe-helpers
const mockFindByStripeId = jest.fn<(...args: unknown[]) => Promise<unknown>>();
// Ordering watermark: accept by default; the out-of-order suite flips it.
const mockClaimOrder = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockFindReversalSub = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ subscription: null, ambiguous: false });
jest.unstable_mockModule('../src/helpers/stripe-helpers.js', () => ({
  findSubscriptionByStripeId: (...args: unknown[]) => mockFindByStripeId(...args),
  claimStripeEventOrder: (...args: unknown[]) => mockClaimOrder(...args),
  findReversalSubscription: (...args: unknown[]) => mockFindReversalSub(...args),
  // Shared by the invoice handlers and stripe-reversals; the real
  // implementation is trivial.
  invoiceSubscriptionId: (invoice: { parent?: { subscription_details?: { subscription?: unknown } } }) => {
    const sub = invoice?.parent?.subscription_details?.subscription;
    return typeof sub === 'string' ? sub : (sub as { id?: string } | undefined)?.id;
  },
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
const mockSubscriptionFindById = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null);
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: (...a: unknown[]) => mockSubscriptionFindOne(...a), findById: (...a: unknown[]) => mockSubscriptionFindById(...a), create: (...args: unknown[]) => mockSubscriptionCreate(...args), countDocuments: jest.fn<(...a: unknown[]) => Promise<number>>().mockResolvedValue(1) },
}));

// Mock provider factory
const mockConstructEvent = jest.fn<AnyFn>();
const mockGetWebhookSecret = jest.fn<AnyFn>().mockReturnValue('whsec_test');
const mockGetStripeClient = jest.fn<AnyFn>().mockReturnValue({
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

// Signup promotions/referral — the shared helper is spied so the settle-later
// (incomplete→active) and Checkout paths can be asserted to invoke it.
const mockRunSignupPromotions = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/helpers/signup-promotions.js', () => ({
  runSignupPromotions: (...a: unknown[]) => mockRunSignupPromotions(...a),
}));

const { planFromStripePrice, handleSubscriptionUpdated, handleSubscriptionCreated, handleSubscriptionDeleted, awaitsLocalRow } = await import('../src/helpers/stripe-subscription-handlers.js');

/** Event envelope the webhook route passes every lifecycle handler. */
const EVT = { id: 'evt_1', created: 1767225600 };
const { handlePaymentFailed } = await import('../src/helpers/stripe-invoice-handlers.js');

describe('Stripe webhook helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      currentPeriodStart: undefined as Date | undefined,
      currentPeriodEnd: undefined as Date | undefined,
      billingAnchorDay: undefined as number | undefined,
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

    await handleSubscriptionUpdated(stripeSub('past_due'), EVT);

    expect(sub.status).toBe('past_due');
    expect(sub.firstFailedAt).toBeInstanceOf(Date);
    expect(sub.save).toHaveBeenCalled();
  });

  it("tracks Stripe's period on every update, not only on a paid invoice", async () => {
    const sub = makeSub({ currentPeriodStart: new Date('2026-08-01T00:00:00Z'), currentPeriodEnd: new Date('2026-09-01T00:00:00Z') });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated({
      ...stripeSub('active'),
      items: { data: [{ current_period_start: Date.UTC(2026, 8, 1) / 1000, current_period_end: Date.UTC(2026, 9, 1) / 1000 }] },
    }, EVT);

    expect(sub.currentPeriodStart).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(sub.currentPeriodEnd).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(sub.billingAnchorDay).toBe(1);
    expect(sub.save).toHaveBeenCalled();
  });

  it('does not save when the period and status are unchanged', async () => {
    const sub = makeSub({ currentPeriodStart: new Date('2026-08-01T00:00:00Z'), currentPeriodEnd: new Date('2026-09-01T00:00:00Z') });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated({
      ...stripeSub('active'),
      items: { data: [{ current_period_start: Date.UTC(2026, 7, 1) / 1000, current_period_end: Date.UTC(2026, 8, 1) / 1000 }] },
    }, EVT);

    expect(sub.save).not.toHaveBeenCalled();
  });

  it('leaves an existing firstFailedAt untouched when already past_due', async () => {
    const existing = new Date('2026-07-01T00:00:00Z');
    const sub = makeSub({ status: 'past_due', firstFailedAt: existing });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('past_due'), EVT);

    // No status/clock change — the in-progress grace window must not reset.
    expect(sub.firstFailedAt).toBe(existing);
  });

  // H1: a `.updated` crossing OUT of an entitled status into a terminal one must
  // downgrade entitlements (no `.deleted` may ever arrive).
  it('downgrades entitlements when an update flips an entitled sub to canceled', async () => {
    const sub = makeSub({ status: 'active', creditLedger: [], creditBalanceCents: 0, recurringDiscount: null });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('canceled'), EVT);

    expect(sub.status).toBe('canceled');
    expect(sub.save).toHaveBeenCalled();
    expect(mockSyncTier).toHaveBeenCalledWith('org-1', 'developer', '', 'sub-1');
  });

  it('downgrades on unpaid (maps to canceled) via update, not only on delete', async () => {
    const sub = makeSub({ status: 'past_due', creditLedger: [], creditBalanceCents: 0, recurringDiscount: null });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('unpaid'), EVT);

    expect(sub.status).toBe('canceled');
    expect(mockSyncTier).toHaveBeenCalledWith('org-1', 'developer', '', 'sub-1');
  });

  it('does NOT downgrade on a benign active→past_due transition (still entitled, grace period)', async () => {
    const sub = makeSub({ status: 'active', creditLedger: [], creditBalanceCents: 0, recurringDiscount: null });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('past_due'), EVT);

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

  it("takes the period from the subscription's items (a trial's included), anchored on its start day", async () => {
    const start = Date.UTC(2026, 0, 31) / 1000;
    const end = Date.UTC(2026, 1, 14) / 1000; // a 14-day trial
    await handleSubscriptionCreated({
      ...created({ orgId: 'org-9', planId: 'team', interval: 'monthly' }),
      items: { data: [{ price: { id: 'price_team_m' }, current_period_start: start, current_period_end: end }] },
    }, EVT);

    expect(mockSubscriptionCreate).toHaveBeenCalledWith(expect.objectContaining({
      currentPeriodStart: new Date('2026-01-31T00:00:00Z'),
      currentPeriodEnd: new Date('2026-02-14T00:00:00Z'),
      billingAnchorDay: 31,
    }));
  });

  it('provisions the local subscription + grants entitlements from checkout metadata', async () => {
    await handleSubscriptionCreated(created({ orgId: 'org-9', planId: 'team', interval: 'monthly' }), EVT);

    expect(mockSubscriptionCreate).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-9',
      planId: 'team',
      status: 'active',
      interval: 'monthly',
      externalId: 'sub_ext',
      externalCustomerId: 'cust_x',
      metadata: { provider: 'stripe' },
    }));
    // Entitlements granted with a real service token + the new sub id.
    expect(mockSyncTier).toHaveBeenCalledWith('org-9', 'team', 'Bearer service-token', 'sub-new');
    expect(mockRunSignupPromotions).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.anything() }), expect.objectContaining({ tier: 'team' }),
      expect.objectContaining({ source: 'stripe_checkout' }),
    );
  });

  it('does NOT grant entitlements for a non-entitlement-worthy status (incomplete)', async () => {
    await handleSubscriptionCreated(created({ orgId: 'org-9', planId: 'team', interval: 'monthly' }, 'incomplete'), EVT);
    expect(mockSubscriptionCreate).toHaveBeenCalled();
    expect(mockSyncTier).not.toHaveBeenCalled();
    expect(mockRunSignupPromotions).not.toHaveBeenCalled();
  });

  it('does NOT provision an out-of-band create with no planId metadata', async () => {
    await handleSubscriptionCreated(created({ orgId: 'org-9' }), EVT);
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
    expect(mockSyncTier).not.toHaveBeenCalled();
  });

  it('delegates to the update handler when a local row already exists', async () => {
    mockFindByStripeId.mockResolvedValue({ orgId: 'org-9', status: 'active', save: jest.fn<AnyFn>(), _id: { toString: () => 'sub-x' } });
    await handleSubscriptionCreated(created({ orgId: 'org-9', planId: 'team', interval: 'monthly' }), EVT);
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
  });

  describe('an in-app create whose .created lands before the bind', () => {
    // POST /subscriptions reserves a row (externalId null), calls Stripe, then
    // saves the sub id. Its Stripe sub carries no orgId — only subscriptionRef.
    const REF = '507f1f77bcf86cd799439011';
    const inApp = () => created({ planId: 'team', interval: 'monthly', subscriptionRef: REF });

    it('throws for a redelivery instead of raising the unbound alarm', async () => {
      mockSubscriptionFindById.mockResolvedValueOnce({ externalId: null, createdAt: new Date() });
      await expect(handleSubscriptionCreated(inApp(), EVT)).rejects.toThrow(/still being bound/);
      expect(mockIncCounter).not.toHaveBeenCalledWith('billing_unbound_stripe_subscription_total', expect.anything());
      expect(mockCreateBillingEvent).not.toHaveBeenCalled();
    });

    it('alarms when the reserved row is gone (the create rolled back after Stripe made the sub)', async () => {
      mockSubscriptionFindById.mockResolvedValueOnce(null);
      await handleSubscriptionCreated(inApp(), EVT);
      expect(mockIncCounter).toHaveBeenCalledWith('billing_unbound_stripe_subscription_total', { reason: 'no_org_metadata' });
    });

    it('alarms when the reserved row never bound inside the bind window', async () => {
      mockSubscriptionFindById.mockResolvedValueOnce({ externalId: null, createdAt: new Date(Date.now() - 60 * 60 * 1000) });
      await handleSubscriptionCreated(inApp(), EVT);
      expect(mockIncCounter).toHaveBeenCalledWith('billing_unbound_stripe_subscription_total', { reason: 'no_org_metadata' });
    });

    it('alarms when the reserved row is bound to a DIFFERENT Stripe sub', async () => {
      mockSubscriptionFindById.mockResolvedValueOnce({ externalId: 'sub_OTHER', createdAt: new Date() });
      await handleSubscriptionCreated(inApp(), EVT);
      expect(mockIncCounter).toHaveBeenCalledWith('billing_unbound_stripe_subscription_total', { reason: 'no_org_metadata' });
    });

    it('a dashboard create with no subscriptionRef alarms without a lookup', async () => {
      await handleSubscriptionCreated(created({}), EVT);
      expect(mockSubscriptionFindById).not.toHaveBeenCalled();
      expect(mockIncCounter).toHaveBeenCalledWith('billing_unbound_stripe_subscription_total', { reason: 'no_org_metadata' });
    });
  });

  it('cancels a DUPLICATE incoming sub when the org already has a manageable one bound elsewhere', async () => {
    // No local row for THIS externalId, but the org already has a manageable sub
    // bound to a DIFFERENT Stripe sub (two checkouts completed) → cancel the
    // incoming duplicate immediately, don't create/orphan a second billing sub.
    mockSubscriptionFindOne.mockResolvedValue({ externalId: 'sub_KEEPER', status: 'active' });
    await handleSubscriptionCreated(created({ orgId: 'org-9', planId: 'team', interval: 'monthly' }), EVT);
    expect(mockCancelSubscriptionNow).toHaveBeenCalledWith('sub_ext');
    expect(mockSubscriptionCreate).not.toHaveBeenCalled();
  });
});

// ============================================
// awaitsLocalRow — whether an event that needs the row should wait for it
// ============================================

describe('awaitsLocalRow', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  const REF = '507f1f77bcf86cd799439011';
  const now = () => ({ id: 'evt_now', created: Math.floor(Date.now() / 1000) });

  it('waits for an in-app create whose reserved row is still unbound', async () => {
    mockSubscriptionFindById.mockResolvedValueOnce({ externalId: null, createdAt: new Date() });
    await expect(awaitsLocalRow({ subscriptionRef: REF }, EVT)).resolves.toBe(true);
  });

  it('does not wait once the reserved row is gone or past the bind window', async () => {
    mockSubscriptionFindById.mockResolvedValueOnce(null);
    await expect(awaitsLocalRow({ subscriptionRef: REF }, EVT)).resolves.toBe(false);
    mockSubscriptionFindById.mockResolvedValueOnce({ externalId: null, createdAt: new Date(Date.now() - 60 * 60 * 1000) });
    await expect(awaitsLocalRow({ subscriptionRef: REF }, EVT)).resolves.toBe(false);
  });

  it('waits for a Checkout sub whose provisioning has not landed, inside the provision window', async () => {
    await expect(awaitsLocalRow({ orgId: 'org-9', planId: 'team' }, now())).resolves.toBe(true);
  });

  it('stops waiting for a Checkout sub once the event is older than the provision window', async () => {
    const old = { id: 'evt_old', created: Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000) };
    await expect(awaitsLocalRow({ orgId: 'org-9', planId: 'team' }, old)).resolves.toBe(false);
  });

  it('never waits for a truly unknown sub (no ref, no Checkout stamp)', async () => {
    await expect(awaitsLocalRow({}, now())).resolves.toBe(false);
    await expect(awaitsLocalRow(null, now())).resolves.toBe(false);
    await expect(awaitsLocalRow({ orgId: 'org-9' }, now())).resolves.toBe(false);
    expect(mockSubscriptionFindById).not.toHaveBeenCalled();
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

    await handleSubscriptionUpdated(stripeIntervalChange(), EVT);

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

    await handleSubscriptionUpdated({ id: 'sub_ext', status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_team_m' } }] } } as any, EVT);

    const types = mockCreateBillingEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain('plan_changed');
    expect(types).not.toContain('interval_changed');
  });
});

// ============================================
// handleSubscriptionUpdated → incomplete settles to active (grant + signup credit)
// ============================================

describe('handleSubscriptionUpdated unentitled → entitled crossing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlanFindById.mockResolvedValue({ _id: 'team', tier: 'team', name: 'Team', prices: { monthly: 7900, annual: 79000 } });
  });

  function makeSub(overrides: Record<string, unknown> = {}) {
    return {
      _id: { toString: () => 'sub-inc' },
      orgId: 'org-inc',
      planId: 'team',
      interval: 'monthly',
      status: 'incomplete',
      cancelAtPeriodEnd: false,
      addons: [{ bundleId: 'seat_pack', quantity: 2 }],
      metadata: { provider: 'stripe' } as Record<string, unknown>,
      save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  const stripeSub = (status: string, metadata: Record<string, string> = {}) =>
    ({ id: 'sub_ext', status, cancel_at_period_end: false, items: { data: [] }, metadata }) as any;

  it('grants the plan tier (service token, with add-ons) + runs signup promotions when incomplete settles to active', async () => {
    const sub = makeSub();
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('active', { referralCode: 'org-referrer' }), EVT);

    expect(sub.status).toBe('active');
    expect(sub.save).toHaveBeenCalled();
    expect(mockSyncTier).toHaveBeenCalledWith('org-inc', 'team', 'Bearer service-token', 'sub-inc', [{ bundleId: 'seat_pack', quantity: 2 }]);
    expect(mockRunSignupPromotions).toHaveBeenCalledWith(sub, expect.objectContaining({ tier: 'team' }), {
      source: 'stripe_settled', referralCode: 'org-referrer',
    });
  });

  it('honors (and consumes) a referral code stashed by the in-app create', async () => {
    const sub = makeSub({ metadata: { provider: 'stripe', pendingReferralCode: 'org-ref-2' } });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('trialing'), EVT);

    expect(mockRunSignupPromotions).toHaveBeenCalledWith(sub, expect.anything(), expect.objectContaining({ referralCode: 'org-ref-2' }));
    expect(sub.metadata.pendingReferralCode).toBeUndefined();
  });

  it('re-grants the tier but NOT signup promotions for a canceled(unpaid) → active recovery', async () => {
    const sub = makeSub({ status: 'canceled' });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('active'), EVT);

    expect(mockSyncTier).toHaveBeenCalledWith('org-inc', 'team', 'Bearer service-token', 'sub-inc', expect.any(Array));
    expect(mockRunSignupPromotions).not.toHaveBeenCalled();
  });

  it('does nothing extra for an already-entitled sub (active → active)', async () => {
    const sub = makeSub({ status: 'active' });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('active'), EVT);

    expect(mockSyncTier).not.toHaveBeenCalled();
    expect(mockRunSignupPromotions).not.toHaveBeenCalled();
  });

  it('does NOT grant while the sub is still incomplete', async () => {
    const sub = makeSub();
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('incomplete'), EVT);

    expect(mockSyncTier).not.toHaveBeenCalled();
    expect(mockRunSignupPromotions).not.toHaveBeenCalled();
  });

  // Grace-lapsed past_due → active via `.updated` BEFORE invoice.payment_succeeded:
  // the marker must be cleared HERE (the invoice handler then sees `active` and
  // never takes its recovery branch) and the tier re-pushed after the save.
  it('clears the grace-lapse marker and re-syncs the tier when a lapsed past_due goes active', async () => {
    const sub = makeSub({ status: 'past_due', metadata: { provider: 'stripe', gracePeriodDowngradedAt: '2026-08-15T00:00:00Z' } });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('active'), EVT);

    expect(sub.metadata.gracePeriodDowngradedAt).toBeUndefined();
    expect(sub.metadata.provider).toBe('stripe');
    expect(sub.save).toHaveBeenCalled();
    expect(mockSyncTier).toHaveBeenCalledTimes(1);
    expect(mockSyncTier).toHaveBeenCalledWith('org-inc', 'team', '', 'sub-inc', [{ bundleId: 'seat_pack', quantity: 2 }]);
    expect(sub.save.mock.invocationCallOrder[0]).toBeLessThan(mockSyncTier.mock.invocationCallOrder[0]);
  });

  it('clears the marker but does not double-sync when the crossing grant already re-pushes the tier', async () => {
    const sub = makeSub({ status: 'canceled', metadata: { gracePeriodDowngradedAt: '2026-08-15T00:00:00Z' } });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('active'), EVT);

    expect(sub.metadata.gracePeriodDowngradedAt).toBeUndefined();
    expect(mockSyncTier).toHaveBeenCalledTimes(1);
  });

  it('leaves the marker on a lapsed sub that is still past_due', async () => {
    const sub = makeSub({ status: 'past_due', firstFailedAt: new Date(), metadata: { gracePeriodDowngradedAt: '2026-08-15T00:00:00Z' } });
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionUpdated(stripeSub('past_due'), EVT);

    expect(sub.metadata.gracePeriodDowngradedAt).toBe('2026-08-15T00:00:00Z');
    expect(mockSyncTier).not.toHaveBeenCalled();
  });
});

// ============================================
// handlePaymentFailed → never revives a terminal subscription
// ============================================

describe('handlePaymentFailed terminal guard', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  const invoice = { id: 'in_late', parent: { subscription_details: { subscription: 'sub_ext' } } } as any;

  function makeSub(status: string) {
    return {
      _id: { toString: () => 'sub-pf' },
      orgId: 'org-pf',
      status,
      failedPaymentAttempts: 0,
      firstFailedAt: undefined as Date | undefined,
      save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  it.each(['canceled', 'incomplete'])('leaves a %s subscription untouched on a late payment_failed', async (status) => {
    const sub = makeSub(status);
    mockFindByStripeId.mockResolvedValue(sub);

    await handlePaymentFailed(invoice, EVT);

    expect(sub.status).toBe(status);
    expect(sub.firstFailedAt).toBeUndefined();
    expect(sub.save).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).not.toHaveBeenCalled();
  });

  it('still moves an active subscription into past_due + starts the grace clock', async () => {
    const sub = makeSub('active');
    mockFindByStripeId.mockResolvedValue(sub);

    await handlePaymentFailed(invoice, EVT);

    expect(sub.status).toBe('past_due');
    expect(sub.failedPaymentAttempts).toBe(1);
    expect(sub.firstFailedAt).toBeInstanceOf(Date);
    expect(sub.save).toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-pf', 'payment_failed', expect.objectContaining({ previousStatus: 'active', newStatus: 'past_due' }), 'sub-pf');
  });
});

// ============================================
// Out-of-order delivery (Stripe guarantees no ordering)
// ============================================

describe('Stripe event ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimOrder.mockResolvedValue(true);
    mockSubscriptionFindOne.mockResolvedValue(null);
    mockPlanFindOne.mockResolvedValue({ _id: 'team', tier: 'team', name: 'Team', isActive: true, prices: { monthly: 7900, annual: 79000 } });
    mockSubscriptionCreate.mockResolvedValue({ _id: { toString: () => 'sub-new' } });
  });

  const makeSub = (status: string) => ({
    _id: { toString: () => 'sub-o' },
    orgId: 'org-o',
    planId: 'team',
    interval: 'monthly',
    status,
    cancelAtPeriodEnd: false,
    addons: [],
    metadata: { provider: 'stripe' },
    save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  });

  it('skips a .updated older than the watermark (a stale past_due must not re-open dunning)', async () => {
    const sub = makeSub('active');
    mockFindByStripeId.mockResolvedValue(sub);
    mockClaimOrder.mockResolvedValueOnce(false);

    await handleSubscriptionUpdated({ id: 'sub_ext', status: 'past_due', cancel_at_period_end: false, items: { data: [] } } as any, EVT);

    expect(mockClaimOrder).toHaveBeenCalledWith(sub._id, EVT);
    expect(sub.status).toBe('active');
    expect(sub.save).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('billing_stripe_stale_event_total', { type: 'customer.subscription.updated' });
  });

  it('provisions via the created path when .updated beats .created and carries checkout metadata', async () => {
    mockFindByStripeId.mockResolvedValue(null);

    await handleSubscriptionUpdated({
      id: 'sub_ext',
      status: 'active',
      cancel_at_period_end: false,
      customer: 'cust_x',
      items: { data: [] },
      metadata: { orgId: 'org-9', planId: 'team', interval: 'monthly' },
    } as any, EVT);

    expect(mockSubscriptionCreate).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-9', planId: 'team', externalId: 'sub_ext' }));
    expect(mockSyncTier).toHaveBeenCalledWith('org-9', 'team', 'Bearer service-token', 'sub-new');
  });

  it('THROWS (so Stripe retries) when .updated has no local row and no checkout metadata', async () => {
    mockFindByStripeId.mockResolvedValue(null);

    await expect(handleSubscriptionUpdated({ id: 'sub_ext', status: 'active', items: { data: [] }, metadata: {} } as any, EVT))
      .rejects.toThrow(/retry/);
  });
});

// ============================================
// customer.subscription.deleted
// ============================================

describe('handleSubscriptionDeleted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimOrder.mockResolvedValue(true);
  });

  const makeSub = (status: string) => ({
    _id: { toString: () => 'sub-d' },
    orgId: 'org-d',
    planId: 'team',
    status,
    cancelAtPeriodEnd: true,
    metadata: { provider: 'stripe' },
    save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  });

  it.each(['active', 'trialing', 'past_due'])('cancels a %s row and downgrades the org', async (status) => {
    const sub = makeSub(status);
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionDeleted({ id: 'sub_ext' } as any, EVT);

    expect(sub.status).toBe('canceled');
    expect(sub.save).toHaveBeenCalled();
    expect(mockSyncTier).toHaveBeenCalledWith('org-d', 'developer', '', 'sub-d');
  });

  // The org may have resubscribed since this row ended (stale-period reconciler,
  // admin override, terminal .updated): a late .deleted for the OLD row must not
  // push developer over the new subscription's paid tier.
  it.each(['canceled', 'incomplete'])('does NOT re-downgrade the org when the row was already %s', async (status) => {
    const sub = makeSub(status);
    mockFindByStripeId.mockResolvedValue(sub);

    await handleSubscriptionDeleted({ id: 'sub_ext' } as any, EVT);

    expect(sub.status).toBe('canceled');
    expect(mockSyncTier).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-d', 'subscription_canceled', expect.objectContaining({ previousStatus: status }), 'sub-d');
  });
});
