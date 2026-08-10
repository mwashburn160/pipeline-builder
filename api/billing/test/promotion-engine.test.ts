// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/promotion-engine — the v1 correctness core. Emulates the
 * atomic mongo semantics with in-memory stores so we can prove: budget cap
 * (never overspends), per-org idempotency (short-circuit AND atomic guard),
 * compensating decrement on the idempotency race and on provider failure, and
 * the provider realizability safety invariant. No real Mongo.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

// ── Config: promotions + discounts on, stub provider ──────────────────
jest.unstable_mockModule('../src/config.js', () => ({
  config: { billingProvider: 'stub', promotions: { enabled: true, clawbackWindowMs: 7 * 24 * 3600 * 1000, backfillIntervalMs: 3600000 }, discounts: { enabled: true } },
}));

// ── creditCents: real formula (dollar = value; percent = % of price) ──
jest.unstable_mockModule('../src/helpers/discount-helpers.js', () => ({
  creditCents: (d: any, price: number) => (d.unit === 'dollar' ? d.value : Math.round((price * d.value) / 100)),
  loadManageableSubscription: jest.fn(),
}));

const mockCreateBillingEvent = jest.fn(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  createBillingEvent: mockCreateBillingEvent,
}));

// ── Provider (swappable per test) ────────────────────────────────────
let providerSupport: 'none' | 'balance' | 'metered' = 'balance';
const mockApplyUsageCredit = jest.fn(async () => ({ ref: { kind: 'stub', ref: 'r1' } }));
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({ usageCreditSupport: providerSupport, applyUsageCredit: mockApplyUsageCredit }),
}));

const mockPlanFindById = jest.fn(() => ({ lean: async () => ({ tier: 'pro', prices: { monthly: 4900, annual: 49000 } }) }));
jest.unstable_mockModule('../src/models/plan.js', () => ({ Plan: { findById: mockPlanFindById } }));

// ── In-memory Promotion store emulating the atomic budget guard ───────
interface Promo { _id: string; isActive: boolean; budgetCents: number; spentCents: number; grantsCount: number; unit: 'dollar' | 'percent'; value: number; perOrgCapCents?: number; maxGrants?: number; trigger: any }
let promo: Promo;
const mockPromoFindOneAndUpdate = jest.fn(async (filter: any, update: any) => {
  if (filter._id !== promo._id) return null;
  if (filter.isActive && !promo.isActive) return null;
  const inc = update.$inc.spentCents as number;
  // Emulate $expr: spentCents + cents <= budgetCents (and grantsCount < maxGrants).
  if (promo.spentCents + inc > promo.budgetCents) return null;
  if (promo.maxGrants != null && !(promo.grantsCount < promo.maxGrants)) return null;
  promo.spentCents += inc;
  promo.grantsCount += update.$inc.grantsCount as number;
  return { ...promo };
});
const mockPromoUpdateOne = jest.fn(async (_filter: any, update: any) => {
  promo.spentCents += update.$inc.spentCents as number;
  promo.grantsCount += update.$inc.grantsCount as number;
  return { acknowledged: true };
});
const mockPromoFind = jest.fn(async () => [promo]);
const mockPromoFindById = jest.fn(async () => promo);
jest.unstable_mockModule('../src/models/promotion.js', () => ({
  Promotion: { findOneAndUpdate: mockPromoFindOneAndUpdate, updateOne: mockPromoUpdateOne, find: mockPromoFind, findById: mockPromoFindById },
}));

// Referral store.
let referralStore: any[];
const mockReferralCreate = jest.fn(async (doc: any) => { if (referralStore.some((r) => r.refereeOrgId === doc.refereeOrgId)) throw new Error('dup key'); referralStore.push(doc); return doc; });
const mockReferralFindOne = jest.fn(async (q: any) => referralStore.find((r) => r.refereeOrgId === q.refereeOrgId && (!q.status || r.status === q.status)) ?? null);
const mockReferralUpdateOne = jest.fn(async (f: any, u: any) => { const r = referralStore.find((x) => x._id === f._id); if (r) Object.assign(r, u.$set); return { acknowledged: true }; });
const mockReferralDeleteOne = jest.fn(async (f: any) => { referralStore = referralStore.filter((r) => r._id !== f._id); return { acknowledged: true }; });
jest.unstable_mockModule('../src/models/referral.js', () => ({
  Referral: { create: mockReferralCreate, findOne: mockReferralFindOne, updateOne: mockReferralUpdateOne, deleteOne: mockReferralDeleteOne },
}));

// ── In-memory Subscription store emulating the dedupeKey idempotency guard ──
interface LedgerRow { discountId: string; cents: number; dedupeKey?: string }
let ledgerStore: LedgerRow[]; // authoritative store (what mongo holds)
const mockSubFindOneAndUpdate = jest.fn(async (filter: any, update: any) => {
  const key = filter['creditLedger.dedupeKey'].$ne as string;
  if (ledgerStore.some((l) => l.dedupeKey === key)) return null; // already granted
  ledgerStore.push(update.$push.creditLedger);
  return { _id: filter._id, creditLedger: ledgerStore };
});
const mockSubUpdateOne = jest.fn(async () => ({ acknowledged: true, modifiedCount: 1 }));
const mockSubFindOne = jest.fn(async () => ({ _id: 'sub_ref', externalCustomerId: 'cus_ref', creditLedger: [] as LedgerRow[], planId: 'plan_1', interval: 'monthly' }));
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOneAndUpdate: mockSubFindOneAndUpdate, updateOne: mockSubUpdateOne, findOne: mockSubFindOne, find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() },
}));

const { grantPromotionToOrg, clawbackRecentPromotions, processReferralSignup, qualifyReferral } = await import('../src/helpers/promotion-engine.js');

const ORG = 'org_1';
const CTX = { tier: 'pro', interval: 'monthly' as const, planPriceCents: 4900 };
const subFixture = () => ({ _id: 'sub_1', externalCustomerId: 'cus_1', creditLedger: [] as LedgerRow[] });

beforeEach(() => {
  jest.clearAllMocks();
  providerSupport = 'balance';
  ledgerStore = [];
  referralStore = [];
  promo = { _id: 'promo_1', isActive: true, budgetCents: 10000, spentCents: 0, grantsCount: 0, unit: 'dollar', value: 5000, trigger: { event: 'subscription_created' } };
});

describe('grantPromotionToOrg', () => {
  it('grants: reserves budget, pushes the ledger row, emits the event', async () => {
    const r = await grantPromotionToOrg(promo as any, subFixture() as any, ORG, CTX);
    expect(r).toMatchObject({ granted: true, cents: 5000 });
    expect(promo.spentCents).toBe(5000);
    expect(promo.grantsCount).toBe(1);
    expect(ledgerStore).toHaveLength(1);
    expect(ledgerStore[0]).toMatchObject({ discountId: 'promo:promo_1', cents: 5000, dedupeKey: 'promo:promo_1:org_1' });
    expect(mockCreateBillingEvent).toHaveBeenCalledTimes(1);
  });

  it('never overspends: reserve fails when the grant would exceed budget', async () => {
    promo.spentCents = 8000; // 8000 + 5000 > 10000
    const r = await grantPromotionToOrg(promo as any, subFixture() as any, ORG, CTX);
    expect(r).toMatchObject({ granted: false, reason: 'budget_exhausted' });
    expect(promo.spentCents).toBe(8000); // unchanged
    expect(ledgerStore).toHaveLength(0);
  });

  it('is idempotent via the in-memory short-circuit (already in the passed ledger)', async () => {
    const sub = subFixture();
    sub.creditLedger.push({ discountId: 'promo:promo_1', cents: 5000, dedupeKey: 'promo:promo_1:org_1' });
    const r = await grantPromotionToOrg(promo as any, sub as any, ORG, CTX);
    expect(r).toMatchObject({ granted: false, reason: 'already_granted' });
    expect(mockPromoFindOneAndUpdate).not.toHaveBeenCalled(); // no reservation attempted
  });

  it('COMPENSATES the reservation when the atomic idempotency guard loses a race', async () => {
    // Stale in-memory sub (empty ledger) but the store already holds the grant —
    // exactly the concurrent-trigger case: reserve succeeds, then the sub guard
    // returns null, so we must release the reservation.
    ledgerStore.push({ discountId: 'promo:promo_1', cents: 5000, dedupeKey: 'promo:promo_1:org_1' });
    const r = await grantPromotionToOrg(promo as any, subFixture() as any, ORG, CTX);
    expect(r).toMatchObject({ granted: false, reason: 'already_granted' });
    expect(promo.spentCents).toBe(0); // reserved then released → net zero
    expect(promo.grantsCount).toBe(0);
  });

  it('COMPENSATES when the provider realization throws (bias to under-spend)', async () => {
    mockApplyUsageCredit.mockRejectedValueOnce(new Error('provider down') as never);
    await expect(grantPromotionToOrg(promo as any, subFixture() as any, ORG, CTX)).rejects.toThrow('provider down');
    expect(promo.spentCents).toBe(0); // released
    expect(ledgerStore).toHaveLength(0);
  });

  it('safety invariant: never grants (or reserves) when the provider cannot realize a credit', async () => {
    providerSupport = 'none';
    const r = await grantPromotionToOrg(promo as any, subFixture() as any, ORG, CTX);
    expect(r).toMatchObject({ granted: false, reason: 'unrealizable' });
    expect(mockPromoFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('percent unit resolves against the plan price', async () => {
    promo.unit = 'percent';
    promo.value = 20; // 20% of 4900 = 980
    const r = await grantPromotionToOrg(promo as any, subFixture() as any, ORG, CTX);
    expect(r).toMatchObject({ granted: true, cents: 980 });
    expect(ledgerStore[0].cents).toBe(980);
  });

  it('perOrgCapCents clamps a single grant', async () => {
    promo.perOrgCapCents = 3000; // value 5000 clamped to 3000
    const r = await grantPromotionToOrg(promo as any, subFixture() as any, ORG, CTX);
    expect(r).toMatchObject({ granted: true, cents: 3000 });
    expect(promo.spentCents).toBe(3000);
  });

  it('respects maxGrants (reserve guard)', async () => {
    promo.maxGrants = 1;
    promo.grantsCount = 1; // already at cap
    const r = await grantPromotionToOrg(promo as any, subFixture() as any, ORG, CTX);
    expect(r).toMatchObject({ granted: false, reason: 'budget_exhausted' });
  });
});

describe('clawbackRecentPromotions', () => {
  it('reverses a recent grant: pulls the ledger row, reduces balance, releases budget', async () => {
    promo.spentCents = 5000; promo.grantsCount = 1;
    const sub = {
      _id: 'sub_1',
      orgId: ORG,
      creditBalanceCents: 5000,
      creditLedger: [{ discountId: 'promo:promo_1', cents: 5000, appliedAt: new Date(), dedupeKey: 'promo:promo_1:org_1' }],
    };
    const count = await clawbackRecentPromotions(sub as any);
    expect(count).toBe(1);
    expect(sub.creditBalanceCents).toBe(0);
    // Ledger $pull + balance $inc -reduce on the subscription, guarded on the row
    // still being present (so a retried cancel can't double-release).
    expect(mockSubUpdateOne).toHaveBeenCalledWith(
      { '_id': 'sub_1', 'creditLedger.dedupeKey': 'promo:promo_1:org_1' },
      { $pull: { creditLedger: { dedupeKey: 'promo:promo_1:org_1' } }, $inc: { creditBalanceCents: -5000 } },
    );
    // …and the budget reservation released on the promotion.
    expect(mockPromoUpdateOne).toHaveBeenCalledWith({ _id: 'promo_1' }, { $inc: { spentCents: -5000, grantsCount: -1 } });
    expect(mockCreateBillingEvent).toHaveBeenCalledTimes(1);
  });

  it('does not claw back grants older than the clawback window', async () => {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000); // 30d ago (> 7d window)
    const sub = {
      _id: 'sub_1',
      orgId: ORG,
      creditBalanceCents: 5000,
      creditLedger: [{ discountId: 'promo:promo_1', cents: 5000, appliedAt: old, dedupeKey: 'k' }],
    };
    const count = await clawbackRecentPromotions(sub as any);
    expect(count).toBe(0);
    expect(mockSubUpdateOne).not.toHaveBeenCalled();
  });

  it('ignores non-promotion ledger rows (discounts)', async () => {
    const sub = {
      _id: 'sub_1',
      orgId: ORG,
      creditBalanceCents: 5000,
      creditLedger: [{ discountId: 'disc_abc', cents: 5000, appliedAt: new Date(), dedupeKey: 'k' }],
    };
    const count = await clawbackRecentPromotions(sub as any);
    expect(count).toBe(0);
  });
});

describe('processReferralSignup (referral)', () => {
  beforeEach(() => { promo.trigger = { event: 'referral' }; });

  it('records a pending referral WITHOUT granting at signup (abuse guard)', async () => {
    await processReferralSignup('referee_org', 'referrer_org', CTX);
    expect(mockReferralCreate).toHaveBeenCalledTimes(1);
    expect(referralStore[0]).toMatchObject({ referrerOrgId: 'referrer_org', refereeOrgId: 'referee_org', status: 'pending' });
    expect(ledgerStore).toHaveLength(0); // no credit until the referee qualifies (first payment)
  });

  it('rejects self-referral (code === referee org)', async () => {
    await processReferralSignup('referee_org', 'referee_org', CTX);
    expect(mockReferralCreate).not.toHaveBeenCalled();
  });

  it('rejects when the referrer is not a subscribed org', async () => {
    mockSubFindOne.mockResolvedValueOnce(null as never); // referrer has no subscription
    await processReferralSignup('referee_org', 'referrer_org', CTX);
    expect(mockReferralCreate).not.toHaveBeenCalled();
  });
});

describe('qualifyReferral (referral)', () => {
  beforeEach(() => { promo.trigger = { event: 'referral' }; });

  it('credits BOTH the referee and the referrer, and marks qualified, on first payment', async () => {
    referralStore.push({ _id: 'ref_1', promotionId: 'promo_1', referrerOrgId: 'referrer_org', refereeOrgId: 'referee_org', status: 'pending' });
    await qualifyReferral('referee_org');
    expect(ledgerStore.some((l) => l.dedupeKey === 'promo:promo_1:referee_org')).toBe(true); // referee credited
    expect(ledgerStore.some((l) => l.dedupeKey === 'promo:promo_1:referrer_org:ref:referee_org')).toBe(true); // referrer credited
    expect(referralStore[0].status).toBe('qualified');
  });

  it('no-ops when there is no pending referral', async () => {
    await qualifyReferral('referee_org');
    expect(mockPromoFindById).not.toHaveBeenCalled();
  });
});
