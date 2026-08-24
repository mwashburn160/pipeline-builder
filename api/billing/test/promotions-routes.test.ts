// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/promotions — the admin promotion surface. Exercises mint
 * (+ validation), the feature-flag 404, and that grant/activate delegate to the
 * engine. Handlers are extracted from the router; the engine + models are mocked.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockAuditRecord = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  requireAuth: (_opts?: unknown) => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSystemAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  getParam: (params: Record<string, string>, key: string) => params[key],
  parseQueryString: (v: unknown) => (typeof v === 'string' ? v : undefined),
  validateBody: (req: { body?: unknown }, schema: { safeParse: (b: unknown) => { success: boolean; data?: unknown; error?: { message: string } } }) => {
    const r = schema.safeParse(req.body ?? {});
    return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error?.message };
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (routeFn: (c: unknown) => Promise<unknown>) => async (req: { user?: { sub?: string; organizationId?: string } }, res: unknown) =>
    routeFn({ req, res, ctx: { log: jest.fn() }, orgId: req.user?.organizationId || '', userId: req.user?.sub || '' }),
}));

jest.unstable_mockModule('../src/services/audit.js', () => ({ getAuditClient: () => ({ record: mockAuditRecord }) }));

// Engine — fully mocked; the route is what's under test here.
let promoEnabled = true;
const mockGrant = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockBatch = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPreview = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockLoadSub = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({
  promotionsEnabled: () => promoEnabled,
  grantPromotionToOrg: mockGrant,
  batchEvaluatePromotion: mockBatch,
  previewPromotion: mockPreview,
  loadManageableSubscription: mockLoadSub,
}));

// Models.
const promoStore = new Map<string, Record<string, unknown>>();
const mockPromoCreate = jest.fn(async (doc: Record<string, unknown>) => { promoStore.set(doc._id as string, { ...doc, createdAt: new Date(), updatedAt: new Date() }); return promoStore.get(doc._id as string); });
const mockPromoFindById = jest.fn(async (id: string) => promoStore.get(id) ?? null);
const mockPromoFind = jest.fn(() => ({ sort: () => ({ limit: async () => [...promoStore.values()] }) }));
jest.unstable_mockModule('../src/models/promotion.js', () => ({
  Promotion: { create: mockPromoCreate, findById: mockPromoFindById, find: mockPromoFind, findByIdAndUpdate: jest.fn() },
}));
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findById: (_id: string) => ({ lean: async () => ({ tier: 'pro', prices: { monthly: 4900, annual: 49000 } }) }) },
}));
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { aggregate: jest.fn(async () => [{ cents: 0, grants: 0 }]) },
}));

const { createPromotionRoutes } = await import('../src/routes/promotions.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const router: any = createPromotionRoutes();
function handler(method: string, routePath: string) {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
const call = (h: Function, req: any) => h({ ...req, params: req.params || {}, query: req.query || {}, user: req.user || { sub: 'admin-1', organizationId: 'org-admin' } }, {});
const adminReq = (over: any = {}) => ({ user: { sub: 'admin-1', organizationId: 'org-admin' }, ...over });
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  jest.clearAllMocks();
  promoEnabled = true;
  promoStore.clear();
});

describe('POST /admin/promotions (mint)', () => {
  it('mints a valid promotion (201) + audits', async () => {
    await call(handler('post', '/admin/promotions'), adminReq({
      body: { name: 'Signup credit', value: 5000, unit: 'dollar', budgetCents: 50000, trigger: { event: 'subscription_created' } },
    }));
    expect(mockPromoCreate).toHaveBeenCalledTimes(1);
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 201, expect.objectContaining({
      promotion: expect.objectContaining({ name: 'Signup credit', value: 5000, unit: 'dollar' }),
    }));
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.promotion.create' }), 'billing');
  });

  it('rejects an invalid body (missing name) with 400', async () => {
    await call(handler('post', '/admin/promotions'), adminReq({
      body: { value: 5000, unit: 'dollar', budgetCents: 50000, trigger: { event: 'subscription_created' } },
    }));
    expect(mockSendError).toHaveBeenCalledWith({}, 400, expect.any(String), 'VALIDATION_ERROR');
    expect(mockPromoCreate).not.toHaveBeenCalled();
  });

  it('rejects a percent value over 100 with 400', async () => {
    await call(handler('post', '/admin/promotions'), adminReq({
      body: { name: 'x', value: 150, unit: 'percent', budgetCents: 50000, trigger: { event: 'subscription_created' } },
    }));
    expect(mockSendError).toHaveBeenCalledWith({}, 400, expect.any(String), 'VALIDATION_ERROR');
  });
});

describe('feature flag', () => {
  // The flag is now enforced by a single router-level middleware (not per-handler),
  // so exercise that middleware layer directly.
  it('the gate middleware 404s all routes when promotions are disabled', () => {
    promoEnabled = false;
    const mw = router.stack.find((l: any) => !l.route && typeof l.handle === 'function')?.handle; // eslint-disable-line @typescript-eslint/no-explicit-any
    const next = jest.fn();
    mw({}, {}, next);
    expect(mockSendError).toHaveBeenCalledWith({}, 404, 'Promotions are not enabled');
    expect(next).not.toHaveBeenCalled();
  });

  it('the gate middleware calls next() when promotions are enabled', () => {
    promoEnabled = true;
    const mw = router.stack.find((l: any) => !l.route && typeof l.handle === 'function')?.handle; // eslint-disable-line @typescript-eslint/no-explicit-any
    const next = jest.fn();
    mw({}, {}, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('POST /admin/promotions/:id/grant', () => {
  it('delegates to the engine and returns the result', async () => {
    promoStore.set('promo_1', { _id: 'promo_1', isActive: true, name: 'P' });
    mockLoadSub.mockResolvedValue({ _id: 'sub_1', planId: 'pro', interval: 'monthly', externalCustomerId: 'cus' } as never);
    mockGrant.mockResolvedValue({ promotionId: 'promo_1', granted: true, cents: 5000 } as never);

    await call(handler('post', '/admin/promotions/:id/grant'), adminReq({ params: { id: 'promo_1' }, body: { targetOrgId: 'org-cust' } }));

    expect(mockGrant).toHaveBeenCalledTimes(1);
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, { result: { promotionId: 'promo_1', granted: true, cents: 5000 } });
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.promotion.grant' }), 'billing');
  });

  it('404s when the target org has no subscription', async () => {
    promoStore.set('promo_1', { _id: 'promo_1', isActive: true });
    mockLoadSub.mockResolvedValue(null as never);
    await call(handler('post', '/admin/promotions/:id/grant'), adminReq({ params: { id: 'promo_1' }, body: { targetOrgId: 'org-cust' } }));
    expect(mockSendError).toHaveBeenCalledWith({}, 404, 'Target org has no active subscription');
    expect(mockGrant).not.toHaveBeenCalled();
  });
});

describe('POST /admin/promotions/:id/activate', () => {
  it('delegates to batchEvaluatePromotion and audits', async () => {
    promoStore.set('promo_1', { _id: 'promo_1', isActive: true });
    mockBatch.mockResolvedValue({ total: 10, matched: 3, granted: 2, alreadyGranted: 1, skippedBudget: 0, spentCents: 10000 } as never);

    await call(handler('post', '/admin/promotions/:id/activate'), adminReq({ params: { id: 'promo_1' } }));

    expect(mockBatch).toHaveBeenCalledTimes(1);
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, expect.objectContaining({ result: expect.objectContaining({ granted: 2 }) }));
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.promotion.activate' }), 'billing');
  });

  it('409s when the promotion is inactive', async () => {
    promoStore.set('promo_1', { _id: 'promo_1', isActive: false });
    await call(handler('post', '/admin/promotions/:id/activate'), adminReq({ params: { id: 'promo_1' } }));
    expect(mockSendError).toHaveBeenCalledWith({}, 409, 'Promotion is not active');
    expect(mockBatch).not.toHaveBeenCalled();
  });
});
