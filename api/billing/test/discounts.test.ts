// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/discounts + helpers/discount-helpers. Exercises
 * mint (+ ceiling), Mode-B token issuance, Mode-A direct grant, self-service
 * redemption (token + alias), the apply validator (target binding, one-coupon,
 * dedupe, reserve-under-cap), and revoke. Handlers are extracted from the
 * router; models + helpers are mocked (no real Mongo).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn<AnyFn>();
const mockSendError = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockAuditRecord,
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

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: jest.fn<AnyFn>(),
  // The discount routes build their rate limiters at construction time (code
  // guessing — see routes/discounts.ts), so this factory is CALLED while the
  // router is built. `stubModule`'s loud stub throws on an un-overridden export,
  // which fails the suite at LOAD; a passthrough keeps the limiter out of the way
  // of handler tests that call the handler directly anyway.
  rateLimitByOrg: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  withRoute: (routeFn: Function) => async (req: any, res: any) => {
    const orgId = req.user?.organizationId || '';
    if (!orgId) return mockSendError(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
    await routeFn({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId, userId: req.user?.sub || '' });
  },
}));

// Config: discounts enabled, stub provider (self-service allowed).
// Mutable so one case can switch the aggregate floor on. `floorPercent` is part
// of the real shape and must be present: without it `100 - undefined` is NaN and
// `credits <= NaN` is false, so EVERY redemption would read as a breach. 0 is the
// default here because these cases are about the redemption mechanics, not the
// floor — the floor's own arithmetic lives in discount-floor.test.ts.
const mockConfig = {
  billingProvider: 'stub',
  discounts: { enabled: true, maxPercent: 100, maxCents: 10_000_000, floorPercent: 0 },
  // The floor's standing figure now includes eligible recurring PROMOTIONS, so
  // the redemption path reads this flag. Off here: these are discount cases, and
  // the cross-instrument behaviour has its own tests.
  promotions: { enabled: false },
};
jest.unstable_mockModule('../src/config.js', () => ({
  // `floorPercent` is part of the real shape: without it `100 - undefined` is NaN
  // and every redemption reads as a floor breach. 0 disables the floor, which is
  // what these cases want — the floor has its own suite (discount-floor.test.ts).
  config: mockConfig,
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
  // The release guard: `$inc` bypasses the schema's `min: 0`, so a release is
  // filtered on `timesRedeemed > 0`. Honoured here or the mock would happily go
  // negative and hide the thing the guard exists for.
  if (filter.timesRedeemed?.$gt !== undefined && !(d.timesRedeemed > filter.timesRedeemed.$gt)) return null;
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
    // Campaign exclusivity: "has this account taken another code in this campaign?"
    exists: async (q: any) => {
      const ids: string[] = q._id?.$in ?? [];
      const hit = ids.map((id) => discountStore.get(id)).find((d) => d && d.campaign === q.campaign);
      return hit ? { _id: hit._id } : null;
    },
  },
}));

// Campaign model mock: the campaign is the authority for the window, the budget
// and the one-per-account rule, so the redemption path reads it on every
// campaigned code.
const campaignStore = new Map<string, any>();
const mockCampaignCreate = jest.fn(async (doc: any) => { campaignStore.set(doc._id, { ...doc, createdAt: new Date(), updatedAt: new Date() }); return campaignStore.get(doc._id); });
jest.unstable_mockModule('../src/models/campaign.js', () => ({
  Campaign: {
    create: mockCampaignCreate,
    findById: async (id: string) => campaignStore.get(id) ?? null,
    exists: async (q: any) => (campaignStore.has(q._id) ? { _id: q._id } : null),
    find: () => ({ sort: () => ({ skip: () => ({ limit: async () => [...campaignStore.values()] }) }) }),
    countDocuments: async () => campaignStore.size,
    findByIdAndUpdate: async (id: string, u: any) => {
      const c = campaignStore.get(id);
      if (!c) return null;
      if (u.$set) Object.assign(c, u.$set);
      return c;
    },
    // The budget claim / release: honour the guards, or the mock hides the very
    // overshoot and underflow they exist to stop.
    findOneAndUpdate: async (filter: any, update: any) => {
      const c = campaignStore.get(filter._id);
      if (!c) return null;
      if (filter.isActive && !c.isActive) return null;
      const inc = update.$inc?.spentCents ?? 0;
      if (inc > 0 && c.budgetCents != null && c.spentCents + inc > c.budgetCents) return null;
      if (filter.spentCents?.$gte !== undefined && !(c.spentCents >= filter.spentCents.$gte)) return null;
      c.spentCents += inc;
      c.grantsCount += update.$inc?.grantsCount ?? 0;
      return c;
    },
    updateOne: async (filter: any, u: any) => {
      const c = campaignStore.get(filter._id);
      if (c && u.$set) Object.assign(c, u.$set);
      return { modifiedCount: c ? 1 : 0 };
    },
  },
}));

let subDoc: any;
const mockSubscriptionFindOne = jest.fn(async () => subDoc);
// Atomic redemption commit (M1): honor the `creditLedger.discountId $ne` guard,
// then apply $push/$inc/$set to the shared subDoc and return it (so existing
// assertions on subDoc keep working).
const mockSubscriptionFindOneAndUpdate = jest.fn(async (filter: any, update: any) => {
  // M1 guard: `creditLedger.discountId: { $ne }` (one-time redemption).
  const idGuard = filter?.['creditLedger.discountId'];
  if (idGuard?.$ne !== undefined && subDoc.creditLedger.some((c: any) => c.discountId === idGuard.$ne)) return null;
  // M2 guard: `creditLedger: { $not: { $elemMatch: {...} } }` (per-period grants).
  const notMatch = filter?.creditLedger?.$not?.$elemMatch;
  if (notMatch && subDoc.creditLedger.some((c: any) => Object.entries(notMatch).every(([k, v]) => (c as any)[k] === v))) return null;
  if (update.$push?.creditLedger) subDoc.creditLedger.push(update.$push.creditLedger);
  if (update.$inc?.creditBalanceCents) subDoc.creditBalanceCents = (subDoc.creditBalanceCents ?? 0) + update.$inc.creditBalanceCents;
  if (update.$set) Object.assign(subDoc, update.$set);
  return subDoc;
});
// Atomic $set (mirror drawdown / recurring expiry) applied to the shared subDoc.
const mockSubscriptionUpdateOne = jest.fn(async (_filter: any, update: any) => {
  if (update.$set) Object.assign(subDoc, update.$set);
  return { modifiedCount: 1 };
});
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: mockSubscriptionFindOne, findOneAndUpdate: mockSubscriptionFindOneAndUpdate, updateOne: mockSubscriptionUpdateOne },
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
const mockVolumeCredits = jest.fn<(...a: unknown[]) => unknown[]>().mockReturnValue([]);
jest.unstable_mockModule('../src/helpers/combo-pricing.js', () => ({
  // Mirrors the real discountBaseCents: plan price unless a bundle scope is set.
  discountBaseCents: (d: { appliesToBundles?: readonly string[] }, planCents: number) => (d.appliesToBundles?.length ? 0 : planCents),
  getComboDiscounts: () => [],
  activeComboCredits: mockActiveComboCredits,
  priceForInterval: (prices: { monthly: number; annual: number }, interval: string) => (interval === 'annual' ? prices.annual : prices.monthly),
  comboLedgerId: (comboId: string) => `combo:${comboId}`,
  volumeDiscountPct: () => 0,
  volumeCredits: mockVolumeCredits,
  volumeLedgerId: (bundleId: string) => `volume:${bundleId}`,
}));

const mockAuditRecord = jest.fn<AnyFn>();

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
const { reconcileDiscountsOnInvoice, clearDiscountsOnCancel, grantPeriodicCredits, applyDiscountToOrg } = await import('../src/helpers/discount-helpers.js');

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
  campaignStore.clear();
  subDoc = freshSub();
});

describe('POST /admin/discounts (mint)', () => {
  it('mints a valid discount and returns the record (201)', async () => {
    await call(handler('post', '/admin/discounts'), adminReq({ body: { code: '50:percent:onetime', targetOrgId: 'org-cust' } }));
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 201, expect.objectContaining({
      discount: expect.objectContaining({ value: 50, unit: 'percent', kind: 'onetime', targetOrgId: 'org-cust' }),
    }));
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.generate' }));
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
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.issue' }));
  });
});

describe('POST /admin/discounts/:id/apply (Mode A)', () => {
  it('grants a coupon directly to the target org', async () => {
    await mockDiscountCreate({ _id: 'disc_c', value: 50, unit: 'percent', kind: 'onetime', isActive: true, targetOrgId: 'org-cust' });
    await call(handler('post', '/admin/discounts/:id/apply'), adminReq({ params: { id: 'disc_c' }, body: { targetOrgId: 'org-cust' } }));
    // 50% of the $49.00 plan. The credit is derived from the NET, not rounded on
    // its own: $49.00 - $24.50 = $24.50 snaps UP to $24.99, so the credit is the
    // $24.01 remainder and the customer is charged a price-shaped figure.
    expect(subDoc.creditBalanceCents).toBe(2401);
    expect(subDoc.creditLedger).toHaveLength(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.apply', orgId: 'org-cust' }));
  });

  it('refuses a coupon that would breach the aggregate floor, WITHOUT burning a redemption', async () => {
    // Plan is $49/mo and the catalog mock prices no add-ons, so list = 4900 and a
    // 40% floor leaves a 2940c budget. A 90% coupon proposes 4410c — more than the
    // budget — so it is refused. maxRedemptions proves the refusal happens BEFORE
    // the atomic reserve: a limited code must not be consumed by a rejection.
    mockConfig.discounts.floorPercent = 40;
    try {
      await mockDiscountCreate({ _id: 'disc_floor', value: 90, unit: 'percent', kind: 'onetime', isActive: true, maxRedemptions: 1 });
      await call(handler('post', '/admin/discounts/:id/apply'), adminReq({ params: { id: 'disc_floor' }, body: { targetOrgId: 'org-cust' } }));
      expect(mockSendError).toHaveBeenCalledWith({}, 409, expect.any(String), 'DISCOUNT_FLOOR_BREACHED');
      expect(subDoc.creditBalanceCents).toBe(0);
      expect(discountStore.get('disc_floor').timesRedeemed).toBe(0);
    } finally {
      mockConfig.discounts.floorPercent = 0;
    }
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
    // 10% of $49.00 is $4.90; net $44.10 snaps up to $44.99, credit $4.01.
    expect(subDoc.creditBalanceCents).toBe(401);
  });

  it('M1: a concurrent duplicate redemption is rejected (atomic guard) and the reservation is released', async () => {
    await mockDiscountCreate({ _id: 'disc_race', value: 5000, unit: 'dollar', kind: 'credit', isActive: true, alias: 'RACE50', maxRedemptions: 5 });
    // Simulate the guard losing the race: the atomic commit finds the discount
    // already banked by a concurrent redemption → returns null.
    mockSubscriptionFindOneAndUpdate.mockResolvedValueOnce(null);
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'RACE50' } });
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 409, expect.any(String), 'ALREADY_REDEEMED');
    // The reservation must be released so a real redeem isn't burned — via a
    // GUARDED update (`timesRedeemed > 0`), because `$inc` bypasses the schema's
    // `min: 0` and a negative counter would defeat `maxRedemptions` outright.
    expect(mockDiscountFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'disc_race', timesRedeemed: { $gt: 0 } },
      { $inc: { timesRedeemed: -1 } },
    );
    expect(subDoc.creditBalanceCents).toBe(0); // nothing banked locally
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

describe('provider push', () => {
  it('posts a recurring discount as a usage credit and sets the standing rule', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockDiscountCreate({ _id: 'disc_push', value: 50, unit: 'percent', kind: 'recurring', isActive: true, alias: 'HALF' });
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'HALF' } });
    // 50% of $49.00, net-snapped to a $24.99 charge -> a $24.01 credit.
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_ext_1', 2401, expect.stringContaining('discount-apply-'));
    expect(subDoc.creditLedger[0].fulfillmentRef).toEqual({ kind: 'balance', ref: 'cbtxn_1' });
    expect(subDoc.recurringDiscount).toMatchObject({ discountId: 'disc_push' });
    const [, , body] = mockSendSuccess.mock.calls[0];
    expect((body as any).priceBreakdown.totalCents).toBe(2499); // $49 − $24.01 credit, a .99 charge
  });

  it('posts a fixed usage credit to the customer balance', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockDiscountCreate({ _id: 'disc_bal', value: 3000, unit: 'dollar', kind: 'credit', isActive: true, alias: 'CR30' });
    await call(handler('post', '/subscriptions/:id/discounts'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'CR30' } });
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_ext_1', 3000, expect.stringContaining('discount-apply-'));
    expect(subDoc.recurringDiscount).toBeNull(); // credit is one-time, not standing
  });

  // A BANKED redemption must never hand its count back. The `credit_applied`
  // billing event is a Mongo write of its own and used to sit inside the `try`,
  // so a failure there rolled the reservation back while the ledger entry and
  // the balance stayed — handing a `maxRedemptions: 1` code back out.
  it('keeps the redemption when only the post-commit billing event fails', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    mockCreateBillingEvent.mockRejectedValueOnce(new Error('event store down'));
    await mockDiscountCreate({ _id: 'disc_evt', value: 10, unit: 'percent', kind: 'onetime', isActive: true, maxRedemptions: 1 });
    const result = await applyDiscountToOrg('org-cust', discountStore.get('disc_evt'), 'u1');
    // The credit committed, so the redemption stands and the count is spent.
    expect(result.ok).toBe(true);
    expect(subDoc.creditLedger).toHaveLength(1);
    expect(discountStore.get('disc_evt').timesRedeemed).toBe(1);
  });

  // `$inc` bypasses the schema's `min: 0`, and a negative counter makes
  // `timesRedeemed < maxRedemptions` permanently true — defeating the cap
  // outright rather than miscounting it. The release is filtered on `> 0`.
  it('never releases a reservation below zero', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockDiscountCreate({ _id: 'disc_zero', value: 10, unit: 'percent', kind: 'onetime', isActive: true, maxRedemptions: 1 });
    // Two failed pushes on a counter that is only ever reserved once each time:
    // each reserves 1 then releases to 0, and the guard stops it going further.
    for (const _ of [0, 1]) {
      mockApplyUsageCredit.mockRejectedValueOnce(new Error('stripe down'));
      await expect(applyDiscountToOrg('org-cust', discountStore.get('disc_zero'), 'u1')).rejects.toThrow('stripe down');
    }
    expect(discountStore.get('disc_zero').timesRedeemed).toBe(0);
  });

  // ONE PER ACCOUNT, ACROSS THE CAMPAIGN. The rule lives on the campaign, not
  // the code, so it cannot be half-applied: the per-code flag this replaced let
  // an unflagged sibling through, and the outcome depended on redemption ORDER.
  it('refuses a second code from an exclusive campaign, in either order', async () => {
    for (const [first, second] of [['camp_a', 'camp_b'], ['camp_b', 'camp_a']] as const) {
      campaignStore.clear();
      discountStore.clear();
      subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
      await mockCampaignCreate({ _id: 'summer26', name: 'Summer 26', exclusive: true, spentCents: 0, grantsCount: 0, isActive: true });
      await mockDiscountCreate({ _id: 'camp_a', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'summer26' });
      await mockDiscountCreate({ _id: 'camp_b', value: 20, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'summer26' });
      expect((await applyDiscountToOrg('org-cust', discountStore.get(first), 'u1')).ok).toBe(true);
      const blocked = await applyDiscountToOrg('org-cust', discountStore.get(second), 'u1');
      expect({ order: `${first} then ${second}`, ...blocked }).toMatchObject({ ok: false, status: 409, code: 'CAMPAIGN_ALREADY_REDEEMED' });
      // Refused BEFORE the reserve, so the second code keeps its redemption.
      expect(discountStore.get(second).timesRedeemed).toBe(0);
    }
  });

  it('allows sibling codes when the campaign is not exclusive', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockCampaignCreate({ _id: 'open26', name: 'Open 26', spentCents: 0, grantsCount: 0, isActive: true });
    await mockDiscountCreate({ _id: 'open_a', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'open26' });
    await mockDiscountCreate({ _id: 'open_b', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'open26' });
    expect((await applyDiscountToOrg('org-cust', discountStore.get('open_a'), 'u1')).ok).toBe(true);
    expect((await applyDiscountToOrg('org-cust', discountStore.get('open_b'), 'u1')).ok).toBe(true);
  });

  // THE CAMPAIGN BUDGET. Nothing used to bound a SET of codes: the mint ceilings
  // bound one coupon and `maxRedemptions` bounds one code's redemptions.
  it('refuses a redemption that would overshoot the campaign budget, and keeps the code', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    // 10% of the $49 plan is 490c once snapped; a 600c budget admits one and not two.
    await mockCampaignCreate({ _id: 'tight', name: 'Tight', budgetCents: 600, spentCents: 0, grantsCount: 0, isActive: true });
    await mockDiscountCreate({ _id: 'b_one', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'tight' });
    await mockDiscountCreate({ _id: 'b_two', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'tight', maxRedemptions: 1 });
    const first = await applyDiscountToOrg('org-cust', discountStore.get('b_one'), 'u1');
    expect(first.ok).toBe(true);
    expect(campaignStore.get('tight').spentCents).toBe((first as any).cents);
    const second = await applyDiscountToOrg('org-cust', discountStore.get('b_two'), 'u1');
    expect(second).toMatchObject({ ok: false, status: 409, code: 'CAMPAIGN_BUDGET_EXHAUSTED' });
    // The code's own redemption was reserved then released — the budget refusal
    // must not burn it.
    expect(discountStore.get('b_two').timesRedeemed).toBe(0);
  });

  it('releases the campaign budget when the redemption fails downstream', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockCampaignCreate({ _id: 'rel', name: 'Release', budgetCents: 10_000, spentCents: 0, grantsCount: 0, isActive: true });
    await mockDiscountCreate({ _id: 'rel_a', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'rel' });
    mockApplyUsageCredit.mockRejectedValueOnce(new Error('stripe down'));
    await expect(applyDiscountToOrg('org-cust', discountStore.get('rel_a'), 'u1')).rejects.toThrow('stripe down');
    // BOTH reservations unwind together, or a campaign leaks budget on an error
    // that gave the code back.
    expect(campaignStore.get('rel').spentCents).toBe(0);
    expect(campaignStore.get('rel').grantsCount).toBe(0);
    expect(discountStore.get('rel_a').timesRedeemed).toBe(0);
  });

  it('refuses redemption outside the campaign window, and when the campaign is ended', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockCampaignCreate({ _id: 'future', name: 'Future', startsAt: new Date(Date.now() + 86_400_000), spentCents: 0, grantsCount: 0, isActive: true });
    await mockCampaignCreate({ _id: 'past', name: 'Past', endsAt: new Date(Date.now() - 86_400_000), spentCents: 0, grantsCount: 0, isActive: true });
    await mockCampaignCreate({ _id: 'dead', name: 'Dead', spentCents: 0, grantsCount: 0, isActive: false });
    await mockDiscountCreate({ _id: 'w_f', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'future' });
    await mockDiscountCreate({ _id: 'w_p', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'past' });
    await mockDiscountCreate({ _id: 'w_d', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'dead' });
    expect(await applyDiscountToOrg('org-cust', discountStore.get('w_f'), 'u1')).toMatchObject({ code: 'CAMPAIGN_NOT_STARTED' });
    expect(await applyDiscountToOrg('org-cust', discountStore.get('w_p'), 'u1')).toMatchObject({ code: 'CAMPAIGN_ENDED' });
    expect(await applyDiscountToOrg('org-cust', discountStore.get('w_d'), 'u1')).toMatchObject({ code: 'CAMPAIGN_INACTIVE' });
  });

  // Mint validates the reference, so this is a deleted campaign or hand-edited
  // data — fail closed rather than redeem it as if it were uncampaigned, which
  // would skip the budget, the window and the one-per-account rule at once.
  it('fails closed when a code references a campaign that no longer exists', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockDiscountCreate({ _id: 'orphan', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'gone' });
    expect(await applyDiscountToOrg('org-cust', discountStore.get('orphan'), 'u1')).toMatchObject({ ok: false, status: 409, code: 'CAMPAIGN_NOT_FOUND' });
    expect(discountStore.get('orphan').timesRedeemed).toBe(0);
  });

  // The credit ledger carries the campaign, so campaign spend is one query over
  // the ledger instead of a join back through discount records.
  it('stamps the campaign onto the credit-ledger row', async () => {
    subDoc = freshSub({ externalCustomerId: 'cus_ext_1' });
    await mockCampaignCreate({ _id: 'stamp', name: 'Stamp', spentCents: 0, grantsCount: 0, isActive: true });
    await mockDiscountCreate({ _id: 's_a', value: 10, unit: 'percent', kind: 'onetime', isActive: true, campaign: 'stamp' });
    await applyDiscountToOrg('org-cust', discountStore.get('s_a'), 'u1');
    expect(subDoc.creditLedger[0]).toMatchObject({ discountId: 's_a', campaign: 'stamp' });
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

describe('preview', () => {
  it('self-service preview returns a projected breakdown without mutating', async () => {
    await mockDiscountCreate({ _id: 'disc_pv', value: 20, unit: 'percent', kind: 'onetime', isActive: true, alias: 'TWENTYOFF' });
    await call(handler('post', '/subscriptions/:id/discounts/preview'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1' }, body: { code: 'TWENTYOFF' } });
    const [, status, body] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect((body as any).priceBreakdown.totalCents).toBe(3999); // 20% off $49, snapped up from $39.20
    expect(subDoc.creditBalanceCents).toBe(0); // not applied
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
  });
});

describe('DELETE /subscriptions/:id/discounts/:discountId (stop recurring)', () => {
  it('clears the standing recurring rule (already-granted credits persist)', async () => {
    subDoc = freshSub({ recurringDiscount: { discountId: 'disc_rm', unit: 'percent', value: 10, appliedAt: new Date() } });
    await call(handler('delete', '/subscriptions/:id/discounts/:discountId'), { user: { sub: 'u1', organizationId: 'org-cust' }, params: { id: 'sub-1', discountId: 'disc_rm' }, body: {} });
    expect(subDoc.recurringDiscount).toBeNull();
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.remove' }));
  });
});

describe('lifecycle reconciliation', () => {
  // reconcileDiscountsOnInvoice (Stripe-only) now persists ATOMICALLY (M2): the
  // mirror + expiry via Subscription.updateOne, grants via findOneAndUpdate. The
  // mocks apply those to the shared `subDoc`, so these assertions read subDoc's
  // resulting state exactly as before — and the webhook's own full-doc save() can
  // no longer clobber a concurrent credit write.

  it('draws the usage-credit mirror down from the Stripe ending balance', async () => {
    subDoc = freshSub({ creditBalanceCents: 5000 });
    await reconcileDiscountsOnInvoice(subDoc as any, { id: 'in_1', ending_balance: -2000 }); // -$20 remaining
    expect(subDoc.creditBalanceCents).toBe(2000);
    expect(mockSubscriptionUpdateOne).toHaveBeenCalledWith({ _id: subDoc._id }, { $set: { creditBalanceCents: 2000 } });
    expect(mockCreateBillingEvent).not.toHaveBeenCalledWith('org-cust', 'credit_exhausted', expect.anything(), expect.anything());
  });

  it('emits credit_exhausted when the balance reaches zero', async () => {
    subDoc = freshSub({ creditBalanceCents: 5000 });
    await reconcileDiscountsOnInvoice(subDoc as any, { id: 'in_1', ending_balance: 0 });
    expect(subDoc.creditBalanceCents).toBe(0);
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-cust', 'credit_exhausted', expect.objectContaining({ previousCents: 5000 }), 'sub-1');
  });

  it('re-grants a recurring discount for the next period (from the current plan price)', async () => {
    await mockDiscountCreate({ _id: 'd2', value: 50, unit: 'percent', kind: 'recurring', isActive: true });
    subDoc = freshSub({ externalCustomerId: 'cus_x', creditLedger: [], recurringDiscount: { discountId: 'd2', unit: 'percent', value: 50 } });
    await reconcileDiscountsOnInvoice(subDoc as any, { id: 'in_2', ending_balance: 0 });
    // 50% of $49.00, net-snapped, re-granted for the upcoming period.
    expect(subDoc.creditBalanceCents).toBe(2401);
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_x', 2401, expect.stringContaining('d2'));
  });

  it('stops re-granting a revoked recurring discount (money-leak guard)', async () => {
    await mockDiscountCreate({ _id: 'd9', value: 50, unit: 'percent', kind: 'recurring', isActive: false });
    subDoc = freshSub({ externalCustomerId: 'cus_x', creditLedger: [], recurringDiscount: { discountId: 'd9', unit: 'percent', value: 50 } });
    await reconcileDiscountsOnInvoice(subDoc as any, { id: 'in_9', ending_balance: 0 });
    expect(subDoc.recurringDiscount).toBeNull();
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-cust', 'discount_expired', expect.objectContaining({ reason: 'recurring_ended' }), 'sub-1');
  });

  it('does nothing extra when there is no recurring rule', async () => {
    subDoc = freshSub({ recurringDiscount: null });
    await reconcileDiscountsOnInvoice(subDoc as any, { id: 'in_3', ending_balance: null });
    expect(subDoc.creditBalanceCents).toBe(0);
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
  });

  it('re-grants a combo credit once per CALENDAR PERIOD, derived from live add-ons', async () => {
    mockActiveComboCredits.mockReturnValue([{ comboId: 'analytics_suite', name: 'Analytics Suite', creditCents: 2000 }]);
    subDoc = freshSub({
      externalCustomerId: 'cus_x',
      addons: [{ bundleId: 'advanced_reporting', quantity: 1 }, { bundleId: 'team_usage_analytics', quantity: 1 }],
    });
    await reconcileDiscountsOnInvoice(subDoc as any, { id: 'in_c1', ending_balance: null });
    expect(subDoc.creditBalanceCents).toBe(2000);
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_x', 2000, expect.stringContaining('combo:analytics_suite'));
    // The ledger dedupe key is the calendar period (YYYY-MM for monthly), NOT the
    // invoice id — this is what stops a second invoice in the same period from
    // double-crediting.
    expect(subDoc.creditLedger).toContainEqual(expect.objectContaining({ discountId: 'combo:analytics_suite', cents: 2000, dedupeKey: expect.stringMatching(/^\d{4}-\d{2}$/) }));

    // H2 regression lock: a DIFFERENT invoice settling in the SAME period (a
    // proration / one-off) must NOT re-grant the combo credit — the atomic
    // $elemMatch dedupe guard rejects it.
    mockApplyUsageCredit.mockClear();
    await reconcileDiscountsOnInvoice(subDoc as any, { id: 'in_c1_proration', ending_balance: null });
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
    expect(subDoc.creditLedger.filter((c: any) => c.discountId === 'combo:analytics_suite')).toHaveLength(1);
  });

  it('stops the combo credit once a member add-on is removed (activeComboCredits → [])', async () => {
    mockActiveComboCredits.mockReturnValue([]); // only one member left → no active combo
    subDoc = freshSub({ externalCustomerId: 'cus_x', addons: [{ bundleId: 'advanced_reporting', quantity: 1 }] });
    await reconcileDiscountsOnInvoice(subDoc as any, { id: 'in_c2', ending_balance: null });
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
    expect(subDoc.creditLedger).toHaveLength(0);
  });

  it('clearDiscountsOnCancel stops the recurring rule and forfeits the local credit', () => {
    const s = freshSub({ recurringDiscount: { discountId: 'd3', unit: 'percent', value: 10 }, creditBalanceCents: 4000 });
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
    expect(s.creditBalanceCents).toBe(2401); // 50% of $49 plan, net-snapped
    expect(mockApplyUsageCredit).toHaveBeenCalledWith('cus_x', 2401, expect.stringContaining('2026-07'));
    // Same period again → idempotent (no second grant).
    mockApplyUsageCredit.mockClear();
    await grantPeriodicCredits(s as any, '2026-07');
    expect(mockApplyUsageCredit).not.toHaveBeenCalled();
    expect(s.creditLedger.filter((c: any) => c.discountId === 'dP')).toHaveLength(1);
  });

  // THE FLOOR APPLIES EVERY PERIOD. It used to be checked only at redemption,
  // while the credits it bounds are re-derived each period from a composition
  // that moves — so an account that grew after redeeming a recurring discount
  // stacked straight past it.
  it('clamps the recurring re-grant to the floor headroom the derived credits leave', async () => {
    mockConfig.discounts.floorPercent = 40;
    try {
      // $49 list, 40% floor → 2940c budget. A derived combo credit takes 2000c of
      // it, leaving 940c of headroom; the recurring 50% wants 2401c on its own.
      mockActiveComboCredits.mockReturnValue([{ comboId: 'analytics_suite', name: 'Analytics Suite', creditCents: 2000 }]);
      await mockDiscountCreate({ _id: 'dClamp', value: 50, unit: 'percent', kind: 'recurring', isActive: true });
      const s = sub({ externalCustomerId: 'cus_x', recurringDiscount: { discountId: 'dClamp', unit: 'percent', value: 50 } });
      await grantPeriodicCredits(s as any, '2026-09');
      // Clamped to the headroom, so the total lands exactly ON the budget rather
      // than 1461c below it.
      expect(s.creditLedger.find((c: any) => c.discountId === 'dClamp')?.cents).toBe(940);
      expect(s.creditBalanceCents).toBe(2940);
      expect(mockCreateBillingEvent).toHaveBeenCalledWith(
        'org-cust', 'discount_floor_clamped',
        expect.objectContaining({ discountId: 'dClamp', wantedCents: 2401, grantedCents: 940 }),
        expect.anything(),
      );
    } finally {
      mockConfig.discounts.floorPercent = 0;
      mockActiveComboCredits.mockReturnValue([]);
    }
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
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.revoke' }));
  });
});
