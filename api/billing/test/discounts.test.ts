// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/discounts + helpers/discount-helpers (Phase 2/3). Exercises
 * mint (+ ceiling), Mode-B token issuance, Mode-A direct grant, self-service
 * redemption (token + alias), the apply validator (target binding, one-coupon,
 * dedupe, reserve-under-cap), and revoke. Handlers are extracted from the
 * router; models + helpers are mocked (no real Mongo).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  requireAuth: (_opts?: any) => (_req: any, _res: any, next: () => void) => next(),
  requirePermission: () => (_req: any, _res: any, next: () => void) => next(),
  requireSystemAdmin: (_req: any, _res: any, next: () => void) => next(),
  getParam: (params: Record<string, string>, key: string) => params[key],
  parseQueryInt: (v: any, d: number) => (v === undefined ? d : parseInt(v, 10)),
  parseQueryIntClamped: (v: any, d: number) => (v === undefined ? d : parseInt(v, 10)),
  parseQueryString: (v: any) => (typeof v === 'string' ? v : undefined),
  validateBody: (req: any, schema: any) => {
    const r = schema.safeParse(req.body ?? {});
    return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message };
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (routeFn: Function) => async (req: any, res: any) => {
    const orgId = req.user?.organizationId || '';
    if (!orgId) return mockSendError(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
    await routeFn({ req, res, ctx: { log: jest.fn() }, orgId, userId: req.user?.sub || '' });
  },
}));

// Config: discounts enabled, stub provider (self-service allowed).
jest.unstable_mockModule('../src/config.js', () => ({
  config: { billingProvider: 'stub', discounts: { enabled: true, maxPercent: 100, maxCents: 10000000 } },
}));

// Model mocks.
const discountStore = new Map<string, any>();
const mockDiscountCreate = jest.fn(async (doc: any) => { discountStore.set(doc._id, { ...doc, timesRedeemed: 0, createdAt: new Date(), updatedAt: new Date() }); return discountStore.get(doc._id); });
const mockDiscountFindById = jest.fn(async (id: string) => discountStore.get(id) ?? null);
const mockDiscountFindOne = jest.fn(async (q: any) => [...discountStore.values()].find((d) => d.alias === q.alias && d.isActive) ?? null);
const mockDiscountFindOneAndUpdate = jest.fn(async (filter: any, update: any) => {
  const d = discountStore.get(filter._id);
  if (!d || (filter.isActive && !d.isActive)) return null;
  if (filter.$expr && !(d.timesRedeemed < d.maxRedemptions)) return null;
  d.timesRedeemed += update.$inc.timesRedeemed;
  return d;
});
const mockDiscountFindByIdAndUpdate = jest.fn(async (id: string, update: any) => {
  const d = discountStore.get(id);
  if (!d) return null;
  if (update.$inc?.timesRedeemed) d.timesRedeemed += update.$inc.timesRedeemed;
  if (update.$set) Object.assign(d, update.$set);
  return d;
});
jest.unstable_mockModule('../src/models/discount.js', () => ({
  Discount: {
    create: mockDiscountCreate,
    findById: mockDiscountFindById,
    findOne: mockDiscountFindOne,
    findOneAndUpdate: mockDiscountFindOneAndUpdate,
    findByIdAndUpdate: mockDiscountFindByIdAndUpdate,
    find: () => ({ sort: () => ({ skip: () => ({ limit: async () => [] }) }) }),
    countDocuments: async () => 0,
  },
}));

let subDoc: any;
const mockSubscriptionFindOne = jest.fn(async () => subDoc);
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: mockSubscriptionFindOne },
}));

const mockPlanFindById = jest.fn((_id: string) => ({ lean: async () => ({ tier: 'pro', prices: { monthly: 4900, annual: 49000 } }) }));
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findById: mockPlanFindById },
}));

const mockCreateBillingEvent = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  createBillingEvent: mockCreateBillingEvent,
  getBundleCatalog: () => [],
  MANAGEABLE_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due'],
}));

// Combo-pricing lives in its own module now: reconcile derives the per-period combo
// credit from live addons via activeComboCredits. Default [] so the existing recurring
// tests (no combo addons) are unaffected; a dedicated test overrides it.
const mockActiveComboCredits = jest.fn<(...a: unknown[]) => unknown[]>().mockReturnValue([]);
jest.unstable_mockModule('../src/helpers/combo-pricing.js', () => ({
  getComboDiscounts: () => [],
  activeComboCredits: mockActiveComboCredits,
  priceForInterval: (prices: { monthly: number; annual: number }, interval: string) => (interval === 'annual' ? prices.annual : prices.monthly),
  comboLedgerId: (comboId: string) => `combo:${comboId}`,
}));

const mockAuditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  getAuditClient: () => ({ record: mockAuditRecord }),
}));

const mockApplyUsageCredit = jest.fn<(...a: unknown[]) => Promise<any>>().mockResolvedValue({ ref: { kind: 'balance', ref: 'cbtxn_1' } });
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({
    applyUsageCredit: mockApplyUsageCredit,
    usageCreditSupport: 'balance',
  }),
}));

// Real codec + real schemas (unmocked) so validation + encode/decode run for real.
process.env.BILLING_DISCOUNT_KEYS = `v1:${Buffer.alloc(32, 3).toString('base64')}`;

const { createDiscountRoutes } = await import('../src/routes/discounts.js');
const { reconcileDiscountsOnInvoice, clearDiscountsOnCancel, grantPeriodicCredits } = await import('../src/helpers/discount-helpers.js');

// Extract handlers by (method, path) from the router stack.
const router: any = createDiscountRoutes();
function handler(method: string, path: string) {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
const call = (h: Function, req: any) => h({ ...req, params: req.params || {}, query: req.query || {}, user: req.user || { sub: 'admin-1', organizationId: 'org-admin' } }, {});

const adminReq = (over: any = {}) => ({ user: { sub: 'admin-1', organizationId: 'org-admin' }, ...over });

function freshSub(over: any = {}) {
  return {
    _id: { toString: () => 'sub-1' },
    orgId: 'org-cust',
    planId: 'pro',
    status: 'active',
    interval: 'monthly',
    recurringDiscount: null,
    creditBalanceCents: 0,
    creditLedger: [] as any[],
    save: jest.fn(async function (this: any) { return this; }),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks resets call history but NOT implementations — re-pin the combo
  // default so a test that overrode it can't leak its return into the next.
  mockActiveComboCredits.mockReturnValue([]);
  discountStore.clear();
  subDoc = freshSub();
});

describe('POST /admin/discounts (mint)', () => {
  it('mints a valid discount and returns the record (201)', async () => {
    await call(handler('post', '/admin/discounts'), adminReq({ body: { code: '50:percent:onetime', targetOrgId: 'org-cust' } }));
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 201, expect.objectContaining({
      discount: expect.objectContaining({ value: 50, unit: 'percent', kind: 'onetime', targetOrgId: 'org-cust' }),
    }));
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.generate' }), 'billing');
  });

  it('rejects a value over the ceiling', async () => {
    // maxCents 10000000 ($100k) → $100,001 exceeds.
    await call(handler('post', '/admin/discounts'), adminReq({ body: { code: '100001:dollar:credit' } }));
    expect(mockSendError).toHaveBeenCalledWith({}, 400, expect.any(String), 'DISCOUNT_CEILING_EXCEEDED');
  });

  it('rejects a malformed authoring form', async () => {
    await call(handler('post', '/admin/discounts'), adminReq({ body: { code: '50:percent' } }));
    expect(mockSendError).toHaveBeenCalledWith({}, 400, expect.any(String), 'VALIDATION_ERROR');
  });
});

describe('POST /admin/discounts/:id/token (Mode B)', () => {
  it('issues an opaque token that round-trips to the discount id', async () => {
    await mockDiscountCreate({ _id: 'disc_x', value: 25, unit: 'dollar', kind: 'recurring', isActive: true });
    await call(handler('post', '/admin/discounts/:id/token'), adminReq({ params: { id: 'disc_x' } }));
    const [, status, body] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect(typeof (body as any).token).toBe('string');
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.issue' }), 'billing');
  });
});

describe('POST /admin/discounts/:id/apply (Mode A)', () => {
  it('grants a coupon directly to the target org', async () => {
    await mockDiscountCreate({ _id: 'disc_c', value: 50, unit: 'percent', kind: 'onetime', isActive: true, targetOrgId: 'org-cust' });
    await call(handler('post', '/admin/discounts/:id/apply'), adminReq({ params: { id: 'disc_c' }, body: { targetOrgId: 'org-cust' } }));
    // onetime = a usage credit of 50% of $49.00 = 2450 cents banked.
    expect(subDoc.creditBalanceCents).toBe(2450);
    expect(subDoc.creditLedger).toHaveLength(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.apply', orgId: 'org-cust' }), 'billing');
  });

  it('rejects a target-org mismatch (403)', async () => {
    await mockDiscountCreate({ _id: 'disc_t', value: 50, unit: 'percent', kind: 'onetime', isActive: true, targetOrgId: 'org-other' });
    await call(handler('post', '/admin/discounts/:id/apply'), adminReq({ params: { id: 'disc_t' }, body: { targetOrgId: 'org-cust' } }));
    expect(mockSendError).toHaveBeenCalledWith({}, 403, expect.any(String), 'DISCOUNT_NOT_FOR_ORG');
  });
});

describe('POST /subscriptions/:id/discounts (self-service redeem)', () => {
  it('applies a usage credit and banks the balance', async () => {
    await mockDiscountCreate({ _id: 'disc_cr', value: 5000, unit: 'dollar', kind: 'credit', isActive: true, alias: 'GIVE50' });
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'GIVE50' } });
    expect(subDoc.creditBalanceCents).toBe(5000);
    expect(subDoc.creditLedger).toHaveLength(1);
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-cust', 'credit_applied', expect.any(Object), 'sub-1', 'u1');
  });

  it('resolves a percent credit against the plan price', async () => {
    await mockDiscountCreate({ _id: 'disc_pc', value: 10, unit: 'percent', kind: 'credit', isActive: true, alias: 'TENPCT' });
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'TENPCT' } });
    // 10% of $49.00 monthly = 490 cents.
    expect(subDoc.creditBalanceCents).toBe(490);
  });

  it('rejects a second recurring discount (one standing rule, 409)', async () => {
    subDoc.recurringDiscount = { discountId: 'disc_existing', unit: 'percent', value: 10, appliedAt: new Date() };
    await mockDiscountCreate({ _id: 'disc_new', value: 20, unit: 'percent', kind: 'recurring', isActive: true, alias: 'TWENTY' });
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'TWENTY' } });
    expect(mockSendError).toHaveBeenCalledWith({}, 409, expect.any(String), 'RECURRING_ALREADY_PRESENT');
  });

  it('rejects an unknown code (404)', async () => {
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'NOPE-NOPE' } });
    expect(mockSendError).toHaveBeenCalledWith({}, 404, expect.any(String), 'DISCOUNT_NOT_FOUND');
  });

  it('reserves under the redemption cap (second redeem exhausts)', async () => {
    await mockDiscountCreate({ _id: 'disc_cap', value: 1000, unit: 'dollar', kind: 'credit', isActive: true, alias: 'ONCE', maxRedemptions: 1 });
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-a' }, params: { id: 'sub-1' }, body: { code: 'ONCE' } });
    subDoc = freshSub();
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u2', organizationId: 'org-b' }, params: { id: 'sub-1' }, body: { code: 'ONCE' } });
    expect(mockSendError).toHaveBeenCalledWith({}, 409, expect.any(String), 'DISCOUNT_EXHAUSTED');
  });
});

describe('provider push (Phase 5)', () => {
  it('posts a recurring discount as a usage credit and sets the standing rule', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockDiscountCreate({ _id: 'disc_push', value: 50, unit: 'percent', kind: 'recurring', isActive: true, alias: 'HALF' });
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'HALF' } });
    // 50% of $49.00 = 2450-cent credit posted to the customer balance.
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_ext_1', 2450, expect.stringContaining('discount-apply-'));
    expect(subDoc.creditLedger[0].fulfillmentRef).toEqual({ kind: 'balance', ref: 'cbtxn_1' });
    expect(subDoc.recurringDiscount).toMatchObject({ discountId: 'disc_push' });
    const [, , body] = mockSendSuccess.mock.calls[0];
    expect((body as any).priceBreakdown.totalCents).toBe(2450); // $49 − $24.50 credit
  });

  it('posts a fixed usage credit to the customer balance', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockDiscountCreate({ _id: 'disc_bal', value: 3000, unit: 'dollar', kind: 'credit', isActive: true, alias: 'CR30' });
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'CR30' } });
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_ext_1', 3000, expect.stringContaining('discount-apply-'));
    expect(subDoc.recurringDiscount).toBeNull(); // credit is one-time, not standing
  });

  it('compensates the reservation when the provider push fails', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    mockApplyUsageCredit.mockRejectedValueOnce(new Error('stripe down'));
    await mockDiscountCreate({ _id: 'disc_fail', value: 10, unit: 'percent', kind: 'onetime', isActive: true, alias: 'TENP', maxRedemptions: 3 });
    await expect(
      call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'TENP' } }),
    ).rejects.toThrow('stripe down');
    // Reserved then rolled back → net 0 redemptions.
    expect(discountStore.get('disc_fail').timesRedeemed).toBe(0);
  });
});

describe('preview (Phase 4)', () => {
  it('self-service preview returns a projected breakdown without mutating', async () => {
    await mockDiscountCreate({ _id: 'disc_pv', value: 20, unit: 'percent', kind: 'onetime', isActive: true, alias: 'TWENTYOFF' });
    await call(handler('post', '/subscriptions/:id/discounts/preview'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'TWENTYOFF' } });
    const [, status, body] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect((body as any).priceBreakdown.totalCents).toBe(3920); // 20% off $49
    expect(subDoc.creditBalanceCents).toBe(0); // not applied
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
  });
});

describe('DELETE /subscriptions/:id/discounts/:discountId (stop recurring)', () => {
  it('clears the standing recurring rule (already-granted credits persist)', async () => {
    subDoc = freshSub({ recurringDiscount: { discountId: 'disc_rm', unit: 'percent', value: 10, appliedAt: new Date() } });
    await call(handler('delete', '/subscriptions/:id/discounts/:discountId'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1', discountId: 'disc_rm' }, body: {} });
    expect(subDoc.recurringDiscount).toBeNull();
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.remove' }), 'billing');
  });
});

describe('lifecycle reconciliation (Phase 6)', () => {
  const sub = (over: any = {}) => ({ _id: { toString: () => 'sub-1' }, orgId: 'org-cust', planId: 'pro', interval: 'monthly', creditBalanceCents: 0, creditLedger: [] as any[], recurringDiscount: null, ...over });

  it('draws the usage-credit mirror down from the Stripe ending balance', async () => {
    const s = sub({ creditBalanceCents: 5000 });
    await reconcileDiscountsOnInvoice(s as any, { id: 'in_1', ending_balance: -2000 }); // -$20 remaining
    expect(s.creditBalanceCents).toBe(2000);
    expect(mockCreateBillingEvent).not.toHaveBeenCalledWith('org-cust', 'credit_exhausted', expect.anything(), expect.anything());
  });

  it('emits credit_exhausted when the balance reaches zero', async () => {
    const s = sub({ creditBalanceCents: 5000 });
    await reconcileDiscountsOnInvoice(s as any, { id: 'in_1', ending_balance: 0 });
    expect(s.creditBalanceCents).toBe(0);
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-cust', 'credit_exhausted', expect.objectContaining({ previousCents: 5000 }), 'sub-1');
  });

  it('re-grants a recurring discount for the next period (from the current plan price)', async () => {
    await mockDiscountCreate({ _id: 'd2', value: 50, unit: 'percent', kind: 'recurring', isActive: true });
    const s = sub({ externalCustomerId: 'cus_x', creditLedger: [], recurringDiscount: { discountId: 'd2', unit: 'percent', value: 50 } });
    await reconcileDiscountsOnInvoice(s as any, { id: 'in_2', ending_balance: 0 });
    // 50% of $49.00 = 2450 re-granted onto the balance for the upcoming period.
    expect(s.creditBalanceCents).toBe(2450);
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_x', 2450, expect.stringContaining('d2'));
  });

  it('stops re-granting a revoked recurring discount (money-leak guard)', async () => {
    await mockDiscountCreate({ _id: 'd9', value: 50, unit: 'percent', kind: 'recurring', isActive: false });
    const s = sub({ externalCustomerId: 'cus_x', creditLedger: [], recurringDiscount: { discountId: 'd9', unit: 'percent', value: 50 } });
    await reconcileDiscountsOnInvoice(s as any, { id: 'in_9', ending_balance: 0 });
    expect(s.recurringDiscount).toBeNull();
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-cust', 'discount_expired', expect.objectContaining({ reason: 'recurring_ended' }), 'sub-1');
  });

  it('does nothing extra when there is no recurring rule', async () => {
    const s = sub({ recurringDiscount: null });
    await reconcileDiscountsOnInvoice(s as any, { id: 'in_3', ending_balance: null });
    expect(s.creditBalanceCents).toBe(0);
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
  });

  it('re-grants a combo credit each period, derived from live add-ons (idempotent per invoice)', async () => {
    mockActiveComboCredits.mockReturnValue([{ comboId: 'analytics_suite', name: 'Analytics Suite', creditCents: 2000 }]);
    const s = sub({
      externalCustomerId: 'cus_x',
      addons: [{ bundleId: 'advanced_reporting', quantity: 1 }, { bundleId: 'team_usage_analytics', quantity: 1 }],
    });
    await reconcileDiscountsOnInvoice(s as any, { id: 'in_c1', ending_balance: null });
    expect(s.creditBalanceCents).toBe(2000);
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_x', 2000, expect.stringContaining('combo:analytics_suite'));
    expect(s.creditLedger).toContainEqual(expect.objectContaining({ discountId: 'combo:analytics_suite', cents: 2000, dedupeKey: 'in_c1' }));

    // A redelivered webhook for the SAME invoice must not double-grant.
    mockApplyUsageCredit.mockClear();
    await reconcileDiscountsOnInvoice(s as any, { id: 'in_c1', ending_balance: null });
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
    expect(s.creditLedger.filter((c: any) => c.discountId === 'combo:analytics_suite')).toHaveLength(1);
  });

  it('stops the combo credit once a member add-on is removed (activeComboCredits → [])', async () => {
    mockActiveComboCredits.mockReturnValue([]); // only one member left → no active combo
    const s = sub({ externalCustomerId: 'cus_x', addons: [{ bundleId: 'advanced_reporting', quantity: 1 }] });
    await reconcileDiscountsOnInvoice(s as any, { id: 'in_c2', ending_balance: null });
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
    expect(s.creditLedger).toHaveLength(0);
  });

  it('clearDiscountsOnCancel stops the recurring rule and forfeits the local credit', () => {
    const s = sub({ recurringDiscount: { discountId: 'd3', unit: 'percent', value: 10 }, creditBalanceCents: 4000 });
    clearDiscountsOnCancel(s as any);
    expect(s.recurringDiscount).toBeNull();
    expect(s.creditBalanceCents).toBe(0);
  });
});

// grantPeriodicCredits — the shared re-grant used by BOTH the Stripe invoice
// reconciler (periodKey = invoice id) and the Marketplace metering cycle
// (periodKey = calendar `YYYY-MM`). The reconcile tests above cover the invoice-id
// path; these assert the Marketplace calendar-period path directly.
describe('grantPeriodicCredits (shared re-grant, calendar period key)', () => {
  const sub = (over: any = {}) => ({ _id: { toString: () => 'sub-1' }, orgId: 'org-cust', planId: 'pro', interval: 'monthly', creditBalanceCents: 0, creditLedger: [] as any[], recurringDiscount: null, ...over });

  it('re-grants a recurring discount keyed by the calendar period, idempotent per period', async () => {
    await mockDiscountCreate({ _id: 'dP', value: 50, unit: 'percent', kind: 'recurring', isActive: true });
    const s = sub({ externalCustomerId: 'cus_x', recurringDiscount: { discountId: 'dP', unit: 'percent', value: 50 } });
    await grantPeriodicCredits(s as any, '2026-07');
    expect(s.creditBalanceCents).toBe(2450); // 50% of $49 plan
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_x', 2450, expect.stringContaining('2026-07'));
    // Same period again → idempotent (no second grant).
    mockApplyUsageCredit.mockClear();
    await grantPeriodicCredits(s as any, '2026-07');
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
    expect(s.creditLedger.filter((c: any) => c.discountId === 'dP')).toHaveLength(1);
  });

  it('re-grants active combo credits keyed by the calendar period', async () => {
    mockActiveComboCredits.mockReturnValue([{ comboId: 'analytics_suite', name: 'Analytics Suite', creditCents: 2000 }]);
    const s = sub({ externalCustomerId: 'cus_x', addons: [{ bundleId: 'advanced_reporting', quantity: 1 }, { bundleId: 'team_usage_analytics', quantity: 1 }] });
    await grantPeriodicCredits(s as any, '2026-08');
    expect(s.creditBalanceCents).toBe(2000);
    expect(s.creditLedger).toContainEqual(expect.objectContaining({ discountId: 'combo:analytics_suite', cents: 2000, dedupeKey: '2026-08' }));
  });
});

describe('PUT /admin/discounts/:id (revoke)', () => {
  it('revokes and audits', async () => {
    await mockDiscountCreate({ _id: 'disc_r', value: 50, unit: 'percent', kind: 'onetime', isActive: true });
    await call(handler('put', '/admin/discounts/:id'), adminReq({ params: { id: 'disc_r' }, body: { isActive: false } }));
    expect(discountStore.get('disc_r').isActive).toBe(false);
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.revoke' }), 'billing');
  });
});
