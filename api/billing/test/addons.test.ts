// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/addons — the add-on bundle management surface
 * (docs/billing-bundles.md §7/§7a). Exercises the feature/self-service gates,
 * catalog filtering, the over-cap 409, and the entitlement fan-out on success.
 * Handlers are extracted from the router; models + helpers are mocked.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks — must be defined before imports

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockRequireAuth = jest.fn((_opts?: any) => (_req: any, _res: any, next: () => void) => next());

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  requireAuth: mockRequireAuth,
  requirePermission: () => (_req: any, _res: any, next: () => void) => next(),
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  getServiceAuthHeader: jest.fn(() => 'Bearer service-token'),
  // Mirror api-core's validateBody: safeParse the real AddonMutateSchema (this
  // suite does not mock ../src/validation/schemas.js) and shape the result.
  validateBody: (req: any, schema: any) => {
    const r = schema.safeParse(req.body ?? {});
    return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message };
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const orgId = req.user?.organizationId || '';
    const userId = req.user?.sub || '';
    const ctx = { log: jest.fn(), identity: { orgId, userId }, requestId: 'req-1' };
    if (!orgId) return mockSendError(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
    try {
      await handler({ req, res, ctx, orgId, userId });
    } catch {
      mockSendError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  },
}));

const mockSubscriptionFindOne = jest.fn<(...args: unknown[]) => any>();
// The add/remove routes commit via a guarded findOneAndUpdate (optimistic
// concurrency). The default impl echoes the loaded sub with the `$set` applied
// (addons + the dot-path providerAddonSyncPending marker) so downstream code sees
// the "committed" doc; return null from a test to simulate a version conflict → 409.
const mockSubscriptionFindOneAndUpdate = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: mockSubscriptionFindOne, findOneAndUpdate: mockSubscriptionFindOneAndUpdate },
}));

const mockPlanFindById = jest.fn<(...args: unknown[]) => any>();
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findById: mockPlanFindById },
}));

const mockSyncAddons = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const mockHasPaymentMethod = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockCreatePortal = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('https://portal.example/session');
// Rebuilt per test so a suite can drop createBillingPortalSession (unsupported provider).
let providerImpl: Record<string, unknown> = {};
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => providerImpl,
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { frontendUrl: 'https://app.example' },
}));

// Billing-helper mocks — the toggles + over-cap gate are the levers under test.
const mockBundlesEnabled = jest.fn<() => boolean>(() => true);
const mockBundleSelfServiceAllowed = jest.fn<() => boolean>(() => true);
const mockCheckEntitlementOvercap = jest.fn<(...args: unknown[]) => Promise<any[]>>().mockResolvedValue([]);
const mockSyncEntitlements = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockCreateBillingEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
// syncProviderAddons moved into billing-helpers (shared with the auto-prune
// finalizer); the add/remove routes call it to reconcile provider line items.
const mockSyncProviderAddons = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
// Combo-discount surface (Phase 5). Default: no combos / no active credit; the
// pure math is unit-tested in billing-helpers.test — here we drive the route's
// use of the return values (the /bundles nudge + the priceBreakdown combo line).
const mockGetComboDiscounts = jest.fn<() => unknown[]>().mockReturnValue([]);
const mockActiveComboCredits = jest.fn<(...args: unknown[]) => unknown[]>().mockReturnValue([]);
const mockVolumeCredits = jest.fn<(...args: unknown[]) => unknown[]>().mockReturnValue([]);

// The tier-filtered catalog fixture: an active stackable pack (pro+), an active
// feature bundle (team+), and an inactive pack (must never surface).
const CATALOG = [
  { id: 'seat_pack', name: 'Seat Pack', description: '+5 seats', isActive: true, stackable: true, availableForTiers: ['pro', 'team', 'enterprise'], prices: { monthly: 1000, annual: 10000 }, grants: { seats: 5 }, features: [] },
  { id: 'audit_log', name: 'Audit Log', description: 'Audit logging', isActive: true, stackable: false, availableForTiers: ['team', 'enterprise'], prices: { monthly: 2000, annual: 20000 }, grants: {}, features: ['audit_log'] },
  { id: 'legacy_pack', name: 'Legacy', description: 'retired', isActive: false, stackable: true, availableForTiers: ['pro'], prices: { monthly: 500, annual: 5000 }, grants: {}, features: [] },
  { id: 'free_feature', name: 'Free Feature', description: 'no charge', isActive: true, stackable: false, availableForTiers: ['pro'], prices: { monthly: 0, annual: 0 }, grants: {}, features: ['free_feature'] },
  // D7: a stackable retention pack capped at maxQuantity (30 + 7×90 = 660 ≤ 730).
  { id: 'retention_pack', name: 'Retention Pack', description: '+90d', isActive: true, stackable: true, availableForTiers: ['pro', 'team', 'enterprise'], prices: { monthly: 1500, annual: 15000 }, grants: { eventRetentionDays: 90 }, features: [], maxQuantity: 7 },
  // Compliance content add-ons: Advanced `requires` Standard (drives the requires
  // gate + cascade-cancel tests). Pure-feature, non-stackable.
  { id: 'compliance_standard', name: 'Standard Compliance', description: 'CI/CD best-practice rules', isActive: true, stackable: false, availableForTiers: ['pro', 'team'], prices: { monthly: 2990, annual: 29900 }, grants: {}, features: ['compliance_standard'] },
  { id: 'compliance_advanced', name: 'Advanced Compliance', description: 'Framework libraries', isActive: true, stackable: false, availableForTiers: ['pro', 'team'], prices: { monthly: 9990, annual: 99900 }, grants: {}, features: ['compliance_advanced'], requires: ['compliance_standard'] },
];

jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  bundlesEnabled: mockBundlesEnabled,
  bundleSelfServiceAllowed: mockBundleSelfServiceAllowed,
  // The add/remove routes now mint their service token via billingServiceAuth
  // (was an inline getServiceAuthHeader) — provide it so the module link resolves.
  billingServiceAuth: jest.fn(() => 'Bearer service-token'),
  buildSubscriptionResponse: (sub: any, planName?: string, tier?: string) => ({ id: sub._id?.toString(), planName, tier, addons: sub.addons }),
  checkEntitlementOvercap: mockCheckEntitlementOvercap,
  createBillingEvent: mockCreateBillingEvent,
  effectiveEntitlements: () => ({ limits: { seats: 10, plugins: 20 }, features: [] }),
  getBundleCatalog: () => CATALOG,
  syncEntitlements: mockSyncEntitlements,
  syncProviderAddons: mockSyncProviderAddons,
  // loadSubAndPlan / the portal route now widen their lookups to the non-terminal
  // set; re-export the real constant so the `$in` filters aren't `undefined`.
  MANAGEABLE_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due'],
}));

// Combo pricing lives in its own module. Inject combos + active credits per test;
// keep a FAITHFUL comboBasisCents so the real comboSavings computes true numbers.
jest.unstable_mockModule('../src/helpers/combo-pricing.js', () => ({
  getComboDiscounts: mockGetComboDiscounts,
  activeComboCredits: mockActiveComboCredits,
  comboBasisCents: (combo: any, bundles: any[], interval: 'monthly' | 'annual') =>
    combo.bundleIds.reduce((s: number, id: string) => {
      const b = bundles.find((x) => x.id === id);
      return s + (b ? b.prices[interval] : 0) * (combo.minQuantities?.[id] ?? 1);
    }, 0),
  volumeDiscountPct: () => 0,
  volumeCredits: mockVolumeCredits,
  volumeLedgerId: (bundleId: string) => `volume:${bundleId}`,
}));

// Central-trail audit client — addon add/remove emit billing.addon.* here
// ALONGSIDE the local billing_events write. Mock it to assert emission.
const mockAuditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  getAuditClient: () => ({ record: mockAuditRecord }),
}));

const { createAddonRoutes } = await import('../src/routes/addons.js');
const router = createAddonRoutes();

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
    body: {},
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
    __v: 0,
    orgId: 'org-1',
    planId: 'pro',
    status: 'active',
    interval: 'monthly',
    externalId: 'ext-sub-1',
    addons: [] as Array<{ bundleId: string; quantity: number }>,
    metadata: {} as Record<string, unknown>,
    // Mixed-path markModified stub — the routes call it when stamping the durable
    // providerAddonSyncPending marker transactionally with the add-on save.
    markModified: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** The sub last loaded via `withActiveSub`, so the guarded findOneAndUpdate can
 *  echo it as the "committed" doc with the `$set` applied. */
let loadedSub: any = null;

/** Wire loadSubAndPlan: Subscription.findOne resolves the doc; Plan.findById().lean() the plan. */
function withActiveSub(sub: any = makeSubscription(), plan: any = { name: 'Pro', tier: 'pro', prices: { monthly: 4000, annual: 40000 } }) {
  mockSubscriptionFindOne.mockResolvedValue(sub);
  mockPlanFindById.mockReturnValue({ lean: jest.fn().mockResolvedValue(plan) });
  loadedSub = sub;
  return sub;
}

beforeEach(() => {
  jest.clearAllMocks();
  loadedSub = null;
  // Default guarded-commit: echo the loaded sub with `$set` (addons + the durable
  // marker) applied. A test may override to return null → simulate a 409 conflict.
  mockSubscriptionFindOneAndUpdate.mockImplementation(async (_filter: any, update: any) => {
    if (!loadedSub) return null;
    const set = update?.$set ?? {};
    const committed: any = { ...loadedSub };
    if ('addons' in set) committed.addons = set.addons;
    if (set['metadata.providerAddonSyncPending']) committed.metadata = { ...(loadedSub.metadata ?? {}), providerAddonSyncPending: true };
    return committed;
  });
  mockBundlesEnabled.mockReturnValue(true);
  mockBundleSelfServiceAllowed.mockReturnValue(true);
  mockCheckEntitlementOvercap.mockResolvedValue([]);
  mockSyncEntitlements.mockResolvedValue(true);
  mockGetComboDiscounts.mockReturnValue([]);
  mockActiveComboCredits.mockReturnValue([]);
  mockHasPaymentMethod.mockResolvedValue(true);
  mockCreatePortal.mockResolvedValue('https://portal.example/session');
  providerImpl = { syncAddons: mockSyncAddons, hasPaymentMethod: mockHasPaymentMethod, createBillingPortalSession: mockCreatePortal };
});

describe('GET /bundles', () => {
  const handler = getHandler('get', '/bundles');

  it('returns an empty catalog when bundles are disabled', async () => {
    mockBundlesEnabled.mockReturnValue(false);
    await handler(mockReq(), mockRes());
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { bundles: [], selfService: false, comboDiscounts: [] });
  });

  it('surfaces a combo whose members are all offered, with per-interval savings', async () => {
    withActiveSub();
    // Combo over two catalog ids both offered on pro (seat_pack $1000, free_feature $0),
    // billed together at $5/mo ⇒ savings = (1000+0) − 500 = 500/mo, (10000+0) − 5000 = 5000/yr.
    mockGetComboDiscounts.mockReturnValue([
      { id: 'demo', name: 'Demo Suite', bundleIds: ['seat_pack', 'free_feature'], prices: { monthly: 500, annual: 5000 }, isActive: true },
    ]);
    await handler(mockReq(), mockRes());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.comboDiscounts).toEqual([
      { id: 'demo', name: 'Demo Suite', bundleIds: ['seat_pack', 'free_feature'], savings: { monthly: 500, annual: 5000 } },
    ]);
  });

  it('omits a combo when a member is not offered on the account tier', async () => {
    withActiveSub();
    // audit_log is team+, so on pro it is filtered out of the catalog → the combo drops.
    mockGetComboDiscounts.mockReturnValue([
      { id: 'nope', name: 'Nope', bundleIds: ['seat_pack', 'audit_log'], prices: { monthly: 100, annual: 1000 }, isActive: true },
    ]);
    await handler(mockReq(), mockRes());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.comboDiscounts).toEqual([]);
  });

  it('echoes minQuantities and applies them to the advertised savings', async () => {
    withActiveSub();
    // seat_pack $1000 × min 2 + free_feature $0 = $2000 basket; combined $500 → save $1500/mo.
    mockGetComboDiscounts.mockReturnValue([
      { id: 'demo', name: 'Demo', bundleIds: ['seat_pack', 'free_feature'], minQuantities: { seat_pack: 2 }, prices: { monthly: 500, annual: 5000 }, isActive: true },
    ]);
    await handler(mockReq(), mockRes());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.comboDiscounts).toEqual([
      { id: 'demo', name: 'Demo', bundleIds: ['seat_pack', 'free_feature'], minQuantities: { seat_pack: 2 }, savings: { monthly: 1500, annual: 15000 } },
    ]);
  });

  it('filters to active bundles available on the account tier and reports selfService', async () => {
    withActiveSub();
    await handler(mockReq(), mockRes());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    // pro tier → seat_pack + free_feature (audit_log is team+, legacy_pack is inactive)
    expect(payload.bundles.map((b: any) => b.id)).toEqual(['seat_pack', 'free_feature', 'retention_pack', 'compliance_standard', 'compliance_advanced']);
    expect(payload.selfService).toBe(true);
  });

  it('marks selfService=false for Marketplace accounts but still returns the catalog', async () => {
    withActiveSub();
    mockBundleSelfServiceAllowed.mockReturnValue(false);
    await handler(mockReq(), mockRes());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.bundles.map((b: any) => b.id)).toEqual(['seat_pack', 'free_feature', 'retention_pack', 'compliance_standard', 'compliance_advanced']);
    expect(payload.selfService).toBe(false);
  });
});

describe('POST /portal (billing portal session)', () => {
  const handler = getHandler('post', '/portal');

  it('404s when the account has no billing customer', async () => {
    mockSubscriptionFindOne.mockResolvedValue(makeSubscription({ externalCustomerId: undefined }));
    await handler(mockReq(), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 404, expect.any(String));
  });

  it('501s when the provider has no hosted portal', async () => {
    mockSubscriptionFindOne.mockResolvedValue(makeSubscription({ externalCustomerId: 'cus-1' }));
    providerImpl = { syncAddons: mockSyncAddons }; // no createBillingPortalSession
    await handler(mockReq(), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 501, expect.any(String));
  });

  it('returns the portal URL, using the request Origin for the return URL', async () => {
    mockSubscriptionFindOne.mockResolvedValue(makeSubscription({ externalCustomerId: 'cus-1' }));
    await handler(mockReq({ headers: { origin: 'https://acme.example' } }), mockRes());
    expect(mockCreatePortal).toHaveBeenCalledWith('cus-1', 'https://acme.example/dashboard/billing');
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { url: 'https://portal.example/session' });
  });

  it('falls back to the configured frontend URL when there is no Origin header', async () => {
    mockSubscriptionFindOne.mockResolvedValue(makeSubscription({ externalCustomerId: 'cus-1' }));
    await handler(mockReq({ headers: {} }), mockRes());
    expect(mockCreatePortal).toHaveBeenCalledWith('cus-1', 'https://app.example/dashboard/billing');
  });
});

describe('POST /subscriptions/:id/addons (add)', () => {
  const handler = getHandler('post', '/subscriptions/:id/addons');

  it('404s when bundles are disabled', async () => {
    mockBundlesEnabled.mockReturnValue(false);
    await handler(mockReq({ body: { bundleId: 'seat_pack' } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 404, expect.any(String));
  });

  it('403s for Marketplace-billed accounts', async () => {
    mockBundleSelfServiceAllowed.mockReturnValue(false);
    await handler(mockReq({ body: { bundleId: 'seat_pack' } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 403, expect.any(String));
  });

  it('400s when bundleId is missing', async () => {
    await handler(mockReq({ body: {} }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('404s when there is no active subscription', async () => {
    mockSubscriptionFindOne.mockResolvedValue(null);
    await handler(mockReq({ body: { bundleId: 'seat_pack' } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 404, 'No active subscription');
  });

  it('400s for an unknown bundle', async () => {
    withActiveSub();
    await handler(mockReq({ body: { bundleId: 'nope' } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 400, expect.stringContaining('Unknown bundle'));
  });

  it('400s when the bundle is not available on the account tier', async () => {
    withActiveSub(); // pro tier
    await handler(mockReq({ body: { bundleId: 'audit_log' } }), mockRes()); // team+
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 400, expect.stringContaining('not available'));
  });

  it('409s with ADDON_OVER_CAP when the change exceeds current usage', async () => {
    withActiveSub();
    const overages = [{ quotaType: 'seats', currentUsage: 12, targetCap: 10, overage: 2 }];
    mockCheckEntitlementOvercap.mockResolvedValue(overages);
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 1 } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 409, expect.any(String), 'ADDON_OVER_CAP', { overages });
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
  });

  it('400s a retention bundle purchased past its maxQuantity ceiling (D7) and does not sync', async () => {
    withActiveSub(); // pro tier — retention_pack (maxQuantity 7) is available
    await handler(mockReq({ body: { bundleId: 'retention_pack', quantity: 8 } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 400, expect.stringContaining('capped at 7'), 'VALIDATION_ERROR');
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
    expect(mockCheckEntitlementOvercap).not.toHaveBeenCalled();
  });

  it('allows a retention bundle exactly AT its maxQuantity', async () => {
    withActiveSub();
    await handler(mockReq({ body: { bundleId: 'retention_pack', quantity: 7 } }), mockRes());
    const [, update] = mockSubscriptionFindOneAndUpdate.mock.calls[0];
    expect(update.$set.addons).toEqual([{ bundleId: 'retention_pack', quantity: 7 }]);
    expect(mockSyncEntitlements).toHaveBeenCalled();
  });

  it('402s a paid increase when the account has no payment method on file', async () => {
    withActiveSub();
    mockHasPaymentMethod.mockResolvedValue(false);
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 2 } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 402, expect.any(String), 'PAYMENT_METHOD_REQUIRED');
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
  });

  it('does NOT gate on payment method when the bundle is free (price 0)', async () => {
    // A $0-priced bundle can't fail to settle, so no card is required.
    withActiveSub();
    mockHasPaymentMethod.mockResolvedValue(false);
    await handler(mockReq({ body: { bundleId: 'free_feature', quantity: 1 } }), mockRes());
    expect(mockSendError).not.toHaveBeenCalledWith(expect.anything(), 402, expect.anything(), 'PAYMENT_METHOD_REQUIRED');
    expect(mockSyncEntitlements).toHaveBeenCalled();
  });

  it('saves, syncs entitlements, and returns 200 on success', async () => {
    withActiveSub();
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 3 } }), mockRes());
    // Committed the new add-on quantity via the guarded findOneAndUpdate ($set.addons,
    // keyed on _id + __v for optimistic concurrency).
    const [filter, update] = mockSubscriptionFindOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: expect.anything(), __v: expect.anything() });
    expect(update.$set.addons).toEqual([{ bundleId: 'seat_pack', quantity: 3 }]);
    // ...fanned out effective entitlements with the new add-on set...
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'pro', 'Bearer service-token', 'sub-1', [{ bundleId: 'seat_pack', quantity: 3 }]);
    // Provider line-item reconcile fires with the new add-on set via the shared
    // syncProviderAddons (externalId, addons, interval, orgId, subscriptionId, source).
    // subscriptionId + source are threaded so a provider failure sets the durable
    // providerAddonSyncPending marker + meters under this source.
    expect(mockSyncProviderAddons).toHaveBeenCalledWith('ext-sub-1', [{ bundleId: 'seat_pack', quantity: 3 }], 'monthly', 'org-1', 'sub-1', 'addon_add');
    // ...and responded 200 with the itemized price breakdown.
    const [, status, payload] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect(payload.addons).toEqual([{ bundleId: 'seat_pack', quantity: 3 }]);
    expect(payload.priceBreakdown.totalCents).toBe(4000 + 1000 * 3); // Pro base + 3× seat pack
  });

  it('stamps providerAddonSyncPending transactionally with the add-on commit (crash-durability)', async () => {
    // The durable marker rides the SAME guarded findOneAndUpdate as the add-on
    // change (dot-path $set) — so a crash before syncProviderAddons still leaves a
    // durable marker for the lifecycle reconciler.
    withActiveSub();
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 2 } }), mockRes());
    const [, update] = mockSubscriptionFindOneAndUpdate.mock.calls[0];
    expect(update.$set['metadata.providerAddonSyncPending']).toBe(true);
  });

  it('does NOT stamp the marker when there is no provider subscription (no externalId)', async () => {
    // No externalId ⇒ syncProviderAddons is a no-op that never clears the marker,
    // so stamping it would strand it forever. It must be skipped.
    withActiveSub(makeSubscription({ externalId: undefined }));
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 2 } }), mockRes());
    const [, update] = mockSubscriptionFindOneAndUpdate.mock.calls[0];
    expect(update.$set['metadata.providerAddonSyncPending']).toBeUndefined();
  });

  it('coerces a stackable quantity to at least 1', async () => {
    withActiveSub();
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 0 } }), mockRes());
    const [, update] = mockSubscriptionFindOneAndUpdate.mock.calls[0];
    expect(update.$set.addons).toEqual([{ bundleId: 'seat_pack', quantity: 1 }]);
  });

  it('appends a NEGATIVE combo line to the price breakdown when a combo is active', async () => {
    // Account already holds free_feature; adding seat_pack completes a combo that
    // activeComboCredits reports as a $20 credit → net = base + seat_pack − 2000.
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'free_feature', quantity: 1 }] }));
    mockActiveComboCredits.mockReturnValue([{ comboId: 'demo', name: 'Demo Suite', creditCents: 2000 }]);
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 1 } }), mockRes());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.priceBreakdown.items).toContainEqual({ label: 'Demo Suite discount', quantity: 1, cents: -2000 });
    // Pro base 4000 + seat_pack 1000 (+ free_feature 0) − 2000 combo credit.
    expect(payload.priceBreakdown.totalCents).toBe(4000 + 1000 + 0 - 2000);
  });

  it('mirrors the add-on add to the CENTRAL audit trail with bundle id + quantity', async () => {
    withActiveSub();
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 3 } }), mockRes());
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.addon.add',
        actorId: 'user-1',
        orgId: 'org-1',
        targetId: 'seat_pack',
        details: expect.objectContaining({ bundleId: 'seat_pack', quantity: 3, subscriptionId: 'sub-1' }),
      }),
      'billing',
    );
  });

  it('never emits card/payment secrets or an account id in the add-on details', async () => {
    withActiveSub(makeSubscription({ externalCustomerId: 'cus_LEAKED', stripeCustomerId: 'cus_LEAKED', awsAccountId: '123456789012' }));
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 2 } }), mockRes());
    const [event] = mockAuditRecord.mock.calls[0];
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('cus_LEAKED');
    expect(serialized).not.toContain('123456789012');
  });

  it('does not emit to the central trail when the over-cap gate blocks the add', async () => {
    withActiveSub();
    mockCheckEntitlementOvercap.mockResolvedValue([{ quotaType: 'seats', currentUsage: 12, targetCap: 10, overage: 2 }]);
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 1 } }), mockRes());
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it('400s an add whose `requires` prerequisite is unmet (Advanced without Standard) and does not sync', async () => {
    withActiveSub(); // no compliance bundles held
    await handler(mockReq({ body: { bundleId: 'compliance_advanced', quantity: 1 } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(
      expect.anything(), 400,
      expect.stringContaining('Advanced Compliance requires the Standard Compliance add-on'),
      'VALIDATION_ERROR',
    );
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
  });

  it('allows Advanced when Standard is already held (prerequisite satisfied by the effective set)', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'compliance_standard', quantity: 1 }] }));
    await handler(mockReq({ body: { bundleId: 'compliance_advanced', quantity: 1 } }), mockRes());
    const [, update] = mockSubscriptionFindOneAndUpdate.mock.calls[0];
    expect(update.$set.addons).toEqual([{ bundleId: 'compliance_standard', quantity: 1 }, { bundleId: 'compliance_advanced', quantity: 1 }]);
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'pro', 'Bearer service-token', 'sub-1', [
      { bundleId: 'compliance_standard', quantity: 1 },
      { bundleId: 'compliance_advanced', quantity: 1 },
    ]);
  });
});

describe('DELETE /subscriptions/:id/addons/:bundleId (remove)', () => {
  const handler = getHandler('delete', '/subscriptions/:id/addons/:bundleId');

  it('403s for Marketplace-billed accounts', async () => {
    mockBundleSelfServiceAllowed.mockReturnValue(false);
    await handler(mockReq({ params: { bundleId: 'seat_pack' } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 403, expect.any(String));
  });

  it('409s with ADDON_OVER_CAP when removal would exceed usage', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'seat_pack', quantity: 2 }] }));
    mockCheckEntitlementOvercap.mockResolvedValue([{ quotaType: 'seats', currentUsage: 12, targetCap: 10, overage: 2 }]);
    await handler(mockReq({ params: { bundleId: 'seat_pack' } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 409, expect.any(String), 'ADDON_OVER_CAP', expect.anything());
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
  });

  it('removes the bundle, syncs, and returns 200', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'seat_pack', quantity: 2 }, { bundleId: 'audit_log', quantity: 1 }] }));
    await handler(mockReq({ params: { bundleId: 'seat_pack' } }), mockRes());
    const [, update] = mockSubscriptionFindOneAndUpdate.mock.calls[0];
    expect(update.$set.addons).toEqual([{ bundleId: 'audit_log', quantity: 1 }]);
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'pro', 'Bearer service-token', 'sub-1', [{ bundleId: 'audit_log', quantity: 1 }]);
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, expect.anything());
  });

  it('mirrors the add-on removal to the CENTRAL audit trail with the bundle id', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'seat_pack', quantity: 2 }] }));
    await handler(mockReq({ params: { bundleId: 'seat_pack' } }), mockRes());
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.addon.remove',
        actorId: 'user-1',
        orgId: 'org-1',
        targetId: 'seat_pack',
        details: expect.objectContaining({ bundleId: 'seat_pack', subscriptionId: 'sub-1' }),
      }),
      'billing',
    );
  });

  it('does not emit to the central trail when the over-cap gate blocks the removal', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'seat_pack', quantity: 2 }] }));
    mockCheckEntitlementOvercap.mockResolvedValue([{ quotaType: 'seats', currentUsage: 12, targetCap: 10, overage: 2 }]);
    await handler(mockReq({ params: { bundleId: 'seat_pack' } }), mockRes());
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it('cascade-removes a dependent when its `requires` prerequisite is removed (Standard → Advanced)', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'compliance_standard', quantity: 1 }, { bundleId: 'compliance_advanced', quantity: 1 }] }));
    await handler(mockReq({ params: { bundleId: 'compliance_standard' } }), mockRes());
    // Both the removed prerequisite AND its dependent are gone.
    const [, update] = mockSubscriptionFindOneAndUpdate.mock.calls[0];
    expect(update.$set.addons).toEqual([]);
    // The over-cap gate + entitlement sync run against the FINAL (cascaded) set.
    expect(mockCheckEntitlementOvercap).toHaveBeenCalledWith('org-1', 'pro', [], '');
    expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'pro', 'Bearer service-token', 'sub-1', []);
  });

  it('audits the cascaded dependent removal, tagged cascadedFrom the removed bundle', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'compliance_standard', quantity: 1 }, { bundleId: 'compliance_advanced', quantity: 1 }] }));
    await handler(mockReq({ params: { bundleId: 'compliance_standard' } }), mockRes());
    // Primary removal audit...
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.addon.remove', targetId: 'compliance_standard' }),
      'billing',
    );
    // ...and the cascaded dependent, tagged cascadedFrom.
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.addon.remove',
        targetId: 'compliance_advanced',
        details: expect.objectContaining({ bundleId: 'compliance_advanced', cascadedFrom: 'compliance_standard', subscriptionId: 'sub-1' }),
      }),
      'billing',
    );
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      { reason: 'addon_removed', bundleId: 'compliance_advanced', cascadedFrom: 'compliance_standard' },
      'sub-1', 'user-1',
    );
  });

  it('does NOT cascade when the removed bundle is not a prerequisite of any held bundle', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'compliance_standard', quantity: 1 }, { bundleId: 'seat_pack', quantity: 1 }] }));
    // Removing seat_pack (not a prerequisite) leaves compliance_standard intact.
    await handler(mockReq({ params: { bundleId: 'seat_pack' } }), mockRes());
    const [, update] = mockSubscriptionFindOneAndUpdate.mock.calls[0];
    expect(update.$set.addons).toEqual([{ bundleId: 'compliance_standard', quantity: 1 }]);
  });

  it('returns lostCombos + emits combo_expired when the removal ends a combo', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'seat_pack', quantity: 1 }, { bundleId: 'free_feature', quantity: 1 }] }));
    // current addons → a combo is active; after removal → none. (First call = current.)
    mockActiveComboCredits.mockReturnValueOnce([{ comboId: 'team_growth', name: 'Team Growth Bundle', creditCents: 2000 }]);
    await handler(mockReq({ params: { bundleId: 'seat_pack' } }), mockRes());
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'combo_expired', { comboId: 'team_growth' }, 'sub-1', 'user-1');
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.lostCombos).toEqual([{ comboId: 'team_growth', name: 'Team Growth Bundle', creditCents: 2000 }]);
  });
});

describe('POST /subscriptions/:id/addons/preview', () => {
  const handler = getHandler('post', '/subscriptions/:id/addons/preview');

  it('403s for Marketplace-billed accounts', async () => {
    mockBundleSelfServiceAllowed.mockReturnValue(false);
    await handler(mockReq({ body: { bundleId: 'seat_pack' } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 403, expect.any(String));
  });

  it('returns effective limits + price breakdown without persisting', async () => {
    withActiveSub();
    await handler(mockReq({ body: { bundleId: 'seat_pack', quantity: 2 } }), mockRes());
    expect(mockSubscriptionFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCheckEntitlementOvercap).not.toHaveBeenCalled();
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.addons).toEqual([{ bundleId: 'seat_pack', quantity: 2 }]);
    expect(payload.effectiveLimits).toEqual({ seats: 10, plugins: 20 });
  });

  it('400s a preview of a retention bundle over its maxQuantity ceiling (D7)', async () => {
    withActiveSub();
    await handler(mockReq({ body: { bundleId: 'retention_pack', quantity: 8 } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 400, expect.stringContaining('capped at 7'), 'VALIDATION_ERROR');
  });

  it('400s a preview of Advanced Compliance when its `requires` prerequisite is unmet', async () => {
    withActiveSub(); // no compliance bundles held
    await handler(mockReq({ body: { bundleId: 'compliance_advanced', quantity: 1 } }), mockRes());
    expect(mockSendError).toHaveBeenCalledWith(
      expect.anything(), 400,
      expect.stringContaining('Advanced Compliance requires the Standard Compliance add-on'),
      'VALIDATION_ERROR',
    );
  });

  it('surfaces the cascade: previewing removal of Standard shows Advanced would be cascaded out (DELETE parity)', async () => {
    withActiveSub(makeSubscription({ addons: [{ bundleId: 'compliance_standard', quantity: 1 }, { bundleId: 'compliance_advanced', quantity: 1 }] }));
    // Removing Standard (quantity 0) leaves Advanced with an unsatisfied `requires`,
    // so the preview must cascade Advanced out too — a dry run, nothing persisted.
    await handler(mockReq({ body: { bundleId: 'compliance_standard', quantity: 0 } }), mockRes());
    expect(mockSubscriptionFindOneAndUpdate).not.toHaveBeenCalled();
    const [, , payload] = mockSendSuccess.mock.calls[0];
    // Both compliance bundles gone from the previewed effective set...
    expect(payload.addons).toEqual([]);
    // ...and the cascaded dependent is surfaced explicitly.
    expect(payload.cascaded).toEqual(['compliance_advanced']);
  });
});
