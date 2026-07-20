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

jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findOne: mockPlanFindOne },
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

jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  buildSubscriptionResponse: mockBuildSubscriptionResponse,
  syncTierToQuotaService: mockSyncTierToQuotaService,
  syncEntitlements: mockSyncTierToQuotaService,
  createBillingEvent: mockCreateBillingEvent,
}));

jest.unstable_mockModule('../src/validation/schemas.js', () => ({
  AdminSubscriptionUpdateSchema: {},
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
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

  it('updates status and logs subscription_updated event', async () => {
    const sub = makeSubscription({ status: 'active' });
    mockSubscriptionFindById.mockResolvedValue(sub);
    mockValidateBody.mockReturnValue({ ok: true, value: { status: 'canceled' } });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'subscription_updated',
      { status: 'canceled' },
      'sub-1', 'admin-1',
    );
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
