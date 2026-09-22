// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/promotion-engine.ts — the paths promotion-engine.test.ts (grant core,
 * clawback, referral happy path) leaves out: the event evaluator's eligibility
 * filter (window, recurring exclusion, tier/interval/first-subscription
 * conditions, fail-soft), the base scans (preview + batch/backfill), the
 * ledger-spend healer, the RECURRING per-period re-grant (both the in-memory and
 * the atomic Stripe-webhook path, each compensating its reservation on failure)
 * and the referral guards. Money paths: every "no grant" branch must also mean
 * "no budget reserved" or a compensating release.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const emitCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ emitCounter }));

const cfg = { billingProvider: 'stub', promotions: { enabled: true, clawbackWindowMs: 7 * 24 * 3600 * 1000, backfillIntervalMs: 3600000 }, discounts: { enabled: true } };
jest.unstable_mockModule('../src/config.js', () => ({ config: cfg }));

const createBillingEvent = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({ createBillingEvent }));

const loadManageableSubscription = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/subscription-status.js', () => ({
  MANAGEABLE_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due'],
  loadManageableSubscription,
}));

const provider: { usageCreditSupport: string; applyUsageCredit?: AnyFn } = { usageCreditSupport: 'balance' };
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({ getPaymentProvider: () => provider }));

const PLANS: Record<string, { tier: string; prices: { monthly: number; annual: number } }> = {
  plan_pro: { tier: 'pro', prices: { monthly: 4900, annual: 49000 } },
  plan_team: { tier: 'team', prices: { monthly: 9900, annual: 99000 } },
};
const planFindById = jest.fn<AnyFn>((id: string) => ({ lean: async () => PLANS[id] ?? null }));
jest.unstable_mockModule('../src/models/plan.js', () => ({ Plan: { findById: planFindById } }));

const Promotion = { find: jest.fn<AnyFn>(), findOneAndUpdate: jest.fn<AnyFn>(), updateOne: jest.fn<AnyFn>(), findById: jest.fn<AnyFn>() };
jest.unstable_mockModule('../src/models/promotion.js', () => ({ Promotion }));
const Referral = { create: jest.fn<AnyFn>(), findOne: jest.fn<AnyFn>(), updateOne: jest.fn<AnyFn>() };
jest.unstable_mockModule('../src/models/referral.js', () => ({ Referral }));

let base: Array<Record<string, unknown>> = [];
const Subscription = {
  find: jest.fn<AnyFn>(() => ({ cursor: () => (async function* () { yield* base; })() })),
  countDocuments: jest.fn<AnyFn>(),
  aggregate: jest.fn<AnyFn>(),
  findOneAndUpdate: jest.fn<AnyFn>(),
  updateOne: jest.fn<AnyFn>(),
};
jest.unstable_mockModule('../src/models/subscription.js', () => ({ Subscription }));

const engine = await import('../src/helpers/promotion-engine.js');

const CTX = { tier: 'pro', interval: 'monthly' as const, planPriceCents: 4900 };
const promo = (over: Record<string, unknown> = {}) => ({
  _id: 'p1',
  campaign: 'launch',
  isActive: true,
  kind: 'one_time',
  unit: 'dollar',
  value: 500,
  budgetCents: 100_000,
  spentCents: 0,
  grantsCount: 0,
  trigger: { event: 'subscription_created' },
  ...over,
}) as any;
const sub = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'sub_1' }, orgId: 'org_1', planId: 'plan_pro', interval: 'monthly', externalCustomerId: 'cus_1', creditBalanceCents: 0, creditLedger: [] as any[], ...over,
}) as any;

beforeEach(() => {
  jest.clearAllMocks();
  cfg.promotions.enabled = true;
  provider.usageCreditSupport = 'balance';
  provider.applyUsageCredit = jest.fn<AnyFn>(async () => ({ ref: { kind: 'stub', ref: 'r1' } }));
  base = [];
  Promotion.find.mockResolvedValue([]);
  Promotion.findOneAndUpdate.mockImplementation(async () => ({ _id: 'p1' }));
  Promotion.updateOne.mockResolvedValue({ acknowledged: true });
  Subscription.findOneAndUpdate.mockImplementation(async (f: { _id: unknown }) => ({ _id: { toString: () => 'sub_1' }, f }));
});

describe('evaluatePromotions — who is eligible', () => {
  it('is a no-op while promotions are disabled', async () => {
    cfg.promotions.enabled = false;
    await expect(engine.evaluatePromotions('org_1', sub(), 'subscription_created', CTX)).resolves.toEqual([]);
    expect(Promotion.find).not.toHaveBeenCalled();
  });

  it('grants only the in-window, non-recurring promotions whose conditions match', async () => {
    const day = 86_400_000;
    Promotion.find.mockResolvedValue([
      promo({ _id: 'ok', trigger: { event: 'subscription_created', conditions: { tiers: ['pro'], intervals: ['monthly'] } } }),
      promo({ _id: 'recurring', kind: 'recurring' }),
      promo({ _id: 'not-started', startsAt: new Date(Date.now() + day) }),
      promo({ _id: 'ended', endsAt: new Date(Date.now() - day) }),
      promo({ _id: 'wrong-tier', trigger: { conditions: { tiers: ['team'] } } }),
      promo({ _id: 'wrong-interval', trigger: { conditions: { intervals: ['annual'] } } }),
      promo({ _id: 'first-only', trigger: { conditions: { firstSubscriptionOnly: true } } }),
    ]);
    const results = await engine.evaluatePromotions('org_1', sub(), 'subscription_created', CTX);
    expect(results.map((r) => r.promotionId)).toEqual(['ok']);
    expect(results[0]).toMatchObject({ granted: true, cents: 500 });
  });

  it('a first-subscription promo matches a first subscription', async () => {
    Promotion.find.mockResolvedValue([promo({ trigger: { conditions: { firstSubscriptionOnly: true } } })]);
    const results = await engine.evaluatePromotions('org_1', sub(), 'subscription_created', { ...CTX, isFirstSubscription: true });
    expect(results).toHaveLength(1);
  });

  it('is fail-soft per promotion: one throwing grant does not block the next', async () => {
    Promotion.find.mockResolvedValue([promo({ _id: 'boom' }), promo({ _id: 'fine' })]);
    Promotion.findOneAndUpdate.mockRejectedValueOnce(new Error('mongo down')).mockResolvedValueOnce({ _id: 'fine' });
    const results = await engine.evaluatePromotions('org_1', sub(), 'subscription_created', CTX);
    expect(results.map((r) => r.promotionId)).toEqual(['fine']);
  });
});

describe('grant core edge cases', () => {
  it('a zero-cent grant reserves nothing', async () => {
    const r = await engine.grantPromotionToOrg(promo({ unit: 'percent', value: 0 }), sub(), 'org_1', CTX);
    expect(r).toEqual({ promotionId: 'p1', granted: false, reason: 'zero' });
    expect(Promotion.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('without an external customer the credit is banked without calling the provider', async () => {
    const r = await engine.grantPromotionToOrg(promo(), sub({ externalCustomerId: undefined }), 'org_1', { ...CTX, actorId: 'u1' });
    expect(r.granted).toBe(true);
    expect(provider.applyUsageCredit).not.toHaveBeenCalled();
    expect(createBillingEvent).toHaveBeenCalledWith('org_1', 'promotion_granted', expect.objectContaining({ promotionId: 'p1', cents: 500 }), 'sub_1', 'u1');
  });

  it('reserves with the grant cap in the guard when maxGrants is set', async () => {
    await engine.grantPromotionToOrg(promo({ maxGrants: 3 }), sub(), 'org_1', CTX);
    const guard = Promotion.findOneAndUpdate.mock.calls[0]![0] as { $expr: { $and?: unknown[] } };
    expect(guard.$expr.$and).toHaveLength(2);
  });
});

describe('previewPromotion — planning projection over the base', () => {
  it('counts eligible subscriptions and caps the projected spend at the remaining budget', async () => {
    base = [
      { orgId: 'a', planId: 'plan_pro', interval: 'monthly' },
      { orgId: 'b', planId: 'plan_pro', interval: 'annual' },
      { orgId: 'c', planId: 'plan_team', interval: 'monthly' },
      { orgId: 'd', planId: 'plan_gone', interval: 'monthly' },
    ];
    const out = await engine.previewPromotion(promo({ unit: 'percent', value: 10, budgetCents: 5000, spentCents: undefined, trigger: { conditions: { tiers: ['pro'] } } }));
    // 10% of 4900 (490) + 10% of 49000 (4900) = 5390, capped at the 5000 remaining.
    expect(out).toEqual({ eligibleOrgs: 2, projectedCents: 5000, remainingBudgetCents: 5000 });
    expect(planFindById).toHaveBeenCalledTimes(3); // plan cache: one lookup per plan id
  });

  it('never reports a negative remaining budget', async () => {
    const out = await engine.previewPromotion(promo({ budgetCents: 100, spentCents: 500 }));
    expect(out).toEqual({ eligibleOrgs: 0, projectedCents: 0, remainingBudgetCents: 0 });
  });
});

describe('batchEvaluatePromotion — activation / backfill', () => {
  const zero = { total: 0, matched: 0, granted: 0, alreadyGranted: 0, skippedBudget: 0, spentCents: 0 };

  it('skips recurring and out-of-window campaigns entirely', async () => {
    base = [{ orgId: 'a', planId: 'plan_pro' }];
    await expect(engine.batchEvaluatePromotion(promo({ kind: 'recurring' }))).resolves.toEqual(zero);
    await expect(engine.batchEvaluatePromotion(promo({ endsAt: new Date(Date.now() - 1000) }))).resolves.toEqual(zero);
    expect(Subscription.find).not.toHaveBeenCalled();
  });

  it('tallies granted / already-granted / budget-skipped / failed orgs over the base', async () => {
    base = [
      sub({ orgId: 'granted' }),
      sub({ orgId: 'dup', creditLedger: [{ dedupeKey: 'promo:p1:dup' }] }),
      sub({ orgId: 'broke' }),
      sub({ orgId: 'throws' }),
      sub({ orgId: 'no-plan', planId: 'plan_gone' }),
      sub({ orgId: 'team', planId: 'plan_team' }),
    ];
    Promotion.findOneAndUpdate
      .mockResolvedValueOnce({ _id: 'p1' }) // granted
      .mockResolvedValueOnce(null) //           broke → budget exhausted
      .mockRejectedValueOnce(new Error('x')); // throws → fail-soft
    const res = await engine.batchEvaluatePromotion(promo({ trigger: { conditions: { tiers: ['pro'] } } }));
    expect(res).toEqual({ total: 6, matched: 4, granted: 1, alreadyGranted: 1, skippedBudget: 1, spentCents: 500 });
  });

  it('derives first-subscription status only when the campaign gates on it', async () => {
    base = [sub({ orgId: 'first' }), sub({ orgId: 'returning' })];
    Subscription.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    const res = await engine.batchEvaluatePromotion(promo({ trigger: { conditions: { firstSubscriptionOnly: true } } }));
    expect(res).toMatchObject({ total: 2, matched: 1, granted: 1 });
    expect(Subscription.countDocuments).toHaveBeenCalledTimes(2);
  });
});

describe('ledger spend: aggregate + heal', () => {
  it('aggregates Σ cents / grants from the ledger (0 when no rows)', async () => {
    Subscription.aggregate.mockResolvedValueOnce([]).mockResolvedValueOnce([{ cents: 1500, grants: 3 }]);
    await expect(engine.aggregatePromotionLedgerSpend('p1')).resolves.toEqual({ cents: 0, grants: 0 });
    await expect(engine.aggregatePromotionLedgerSpend('p1')).resolves.toEqual({ cents: 1500, grants: 3 });
  });

  it('rewrites the advisory cache only when it drifted from the ledger', async () => {
    Subscription.aggregate.mockResolvedValue([{ cents: 1500, grants: 3 }]);
    await engine.reconcilePromotionSpend({ _id: 'p1', spentCents: 1500, grantsCount: 3 } as any);
    expect(Promotion.updateOne).not.toHaveBeenCalled();
    await engine.reconcilePromotionSpend({ _id: 'p1', spentCents: 2000, grantsCount: 3 } as any);
    expect(Promotion.updateOne).toHaveBeenCalledWith({ _id: 'p1' }, { $set: { spentCents: 1500, grantsCount: 3 } });
  });
});

describe('grantRecurringPromotions — per-period re-grant', () => {
  it('is a no-op when disabled, when the provider cannot realize credits, or when the plan is gone', async () => {
    cfg.promotions.enabled = false;
    await engine.grantRecurringPromotions(sub(), '2026-09');
    cfg.promotions.enabled = true;
    provider.usageCreditSupport = 'none';
    await engine.grantRecurringPromotions(sub(), '2026-09');
    provider.usageCreditSupport = 'balance';
    await engine.grantRecurringPromotions(sub({ planId: 'plan_gone' }), '2026-09');
    expect(Promotion.find).not.toHaveBeenCalled();
  });

  it('in-memory path: grants each eligible promo once per period, skipping zero, exhausted and failed realizations', async () => {
    const s = sub({ creditLedger: [{ dedupeKey: 'promo:done:org_1:2026-09', discountId: 'promo:done', cents: 1 }] });
    Promotion.find.mockResolvedValue([
      promo({ _id: 'done', kind: 'recurring' }),
      promo({ _id: 'zero', kind: 'recurring', unit: 'percent', value: 0 }),
      promo({ _id: 'exhausted', kind: 'recurring' }),
      promo({ _id: 'realize-fails', kind: 'recurring' }),
      promo({ _id: 'ok', kind: 'recurring', unit: 'percent', value: 10 }),
      promo({ _id: 'out-of-window', kind: 'recurring', startsAt: new Date(Date.now() + 86_400_000) }),
    ]);
    Promotion.findOneAndUpdate
      .mockResolvedValueOnce(null) // exhausted
      .mockResolvedValueOnce({ _id: 'realize-fails' })
      .mockResolvedValueOnce({ _id: 'ok' });
    (provider.applyUsageCredit as jest.Mock<AnyFn>).mockRejectedValueOnce(new Error('stripe down')).mockResolvedValueOnce({ ref: { kind: 'stub', ref: 'r2' } });
    await engine.grantRecurringPromotions(s, '2026-09');
    expect(Promotion.updateOne).toHaveBeenCalledWith({ _id: 'realize-fails' }, { $inc: { spentCents: -500, grantsCount: -1 } });
    expect(s.creditBalanceCents).toBe(490);
    expect(s.creditLedger.map((l: { dedupeKey?: string }) => l.dedupeKey)).toContain('promo:ok:org_1:2026-09');
    expect(createBillingEvent).toHaveBeenCalledTimes(1);
    expect(Subscription.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('atomic (Stripe webhook) path: a guarded write, compensated when the period was already granted', async () => {
    Promotion.find.mockResolvedValue([promo({ _id: 'a', kind: 'recurring' }), promo({ _id: 'b', kind: 'recurring' })]);
    Subscription.findOneAndUpdate.mockResolvedValueOnce({ _id: 'sub_1' }).mockResolvedValueOnce(null);
    const s = sub({ externalCustomerId: undefined });
    await engine.grantRecurringPromotions(s, '2026-10', { atomic: true });
    expect(Subscription.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(createBillingEvent).toHaveBeenCalledWith('org_1', 'promotion_granted', expect.objectContaining({ promotionId: 'a', periodKey: '2026-10' }), 'sub_1');
    expect(Promotion.updateOne).toHaveBeenCalledWith({ _id: 'b' }, { $inc: { spentCents: -500, grantsCount: -1 } });
    expect(s.creditLedger).toHaveLength(0); // the atomic path never touches the in-memory ledger
  });
});

describe('clawback guards', () => {
  it('is a no-op while disabled, and never double-releases a grant another cancel already reversed', async () => {
    cfg.promotions.enabled = false;
    await expect(engine.clawbackRecentPromotions(sub())).resolves.toBe(0);
    cfg.promotions.enabled = true;
    Subscription.updateOne.mockResolvedValue({ modifiedCount: 0 });
    const s = sub({ creditBalanceCents: 300, creditLedger: [{ discountId: 'promo:p1', cents: 500, dedupeKey: 'k', appliedAt: new Date() }, { discountId: 'promo:p2', cents: 1, dedupeKey: 'old' }] });
    await expect(engine.clawbackRecentPromotions(s)).resolves.toBe(0);
    expect(Promotion.updateOne).not.toHaveBeenCalled();
  });
});

describe('referral guards', () => {
  const referralPromo = promo({ _id: 'ref', trigger: { event: 'referral' }, referrerValue: 1000 });

  it('records nothing when disabled, without a code, on self-referral, or when credits are unrealizable', async () => {
    cfg.promotions.enabled = false;
    await engine.processReferralSignup('org_new', 'org_ref', CTX);
    cfg.promotions.enabled = true;
    await engine.processReferralSignup('org_new', '   ', CTX);
    await engine.processReferralSignup('org_new', 'org_new', CTX);
    provider.usageCreditSupport = 'none';
    await engine.processReferralSignup('org_new', 'org_ref', CTX);
    expect(Referral.create).not.toHaveBeenCalled();
  });

  it('needs a matching active referral promotion and a subscribed referrer; a duplicate is ignored', async () => {
    Promotion.find.mockResolvedValueOnce([]);
    await engine.processReferralSignup('org_new', 'org_ref', CTX);
    expect(Referral.create).not.toHaveBeenCalled();
    Promotion.find.mockResolvedValue([referralPromo]);
    loadManageableSubscription.mockResolvedValueOnce(null);
    await engine.processReferralSignup('org_new', 'org_ref', CTX);
    expect(Referral.create).not.toHaveBeenCalled();
    loadManageableSubscription.mockResolvedValue(sub({ orgId: 'org_ref' }));
    Referral.create.mockRejectedValueOnce(new Error('E11000 duplicate key'));
    await expect(engine.processReferralSignup('org_new', ' org_ref ', CTX)).resolves.toBeUndefined();
    expect(Referral.create).toHaveBeenCalledWith(expect.objectContaining({ referrerOrgId: 'org_ref', refereeOrgId: 'org_new', status: 'pending' }));
  });

  it('qualifying: no-op when disabled or when the promotion was revoked', async () => {
    cfg.promotions.enabled = false;
    await engine.qualifyReferral('org_new');
    expect(Referral.findOne).not.toHaveBeenCalled();
    cfg.promotions.enabled = true;
    Referral.findOne.mockResolvedValue({ _id: 'r1', promotionId: 'ref', referrerOrgId: 'org_ref' });
    Promotion.findById.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...referralPromo, isActive: false });
    await engine.qualifyReferral('org_new');
    await engine.qualifyReferral('org_new');
    expect(Referral.updateOne).not.toHaveBeenCalled();
  });

  it('qualifying still terminates the referral when a side can no longer be credited', async () => {
    Referral.findOne.mockResolvedValue({ _id: 'r1', promotionId: 'ref', referrerOrgId: 'org_ref' });
    Promotion.findById.mockResolvedValue(referralPromo);
    // Referee left; referrer still subscribed but its budget reservation fails.
    loadManageableSubscription.mockImplementation(async (orgId: string) => (orgId === 'org_ref' ? sub({ orgId: 'org_ref' }) : null));
    Promotion.findOneAndUpdate.mockResolvedValueOnce(null);
    await engine.qualifyReferral('org_new');
    expect(Referral.updateOne).toHaveBeenCalledWith({ _id: 'r1' }, { $set: expect.objectContaining({ status: 'qualified', refereeGrantCents: 0, referrerGrantCents: 0 }) });
  });

  it('credits the referrer with referrerValue on a qualifying payment', async () => {
    Referral.findOne.mockResolvedValue({ _id: 'r1', promotionId: 'ref', referrerOrgId: 'org_ref' });
    Promotion.findById.mockResolvedValue(referralPromo);
    loadManageableSubscription.mockImplementation(async (orgId: string) => sub({ orgId }));
    await engine.qualifyReferral('org_new');
    expect(Referral.updateOne).toHaveBeenCalledWith({ _id: 'r1' }, { $set: expect.objectContaining({ refereeGrantCents: 500, referrerGrantCents: 1000 }) });
  });
});
