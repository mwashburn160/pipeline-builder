/**
 * Tests for routes/admin-subscriptions.
 *
 * Tests admin billing routes by extracting handlers from the router.
 * Mocks Mongoose models, billing helpers, and api-core utilities.
 */

// ---------------------------------------------------------------------------
// Mocks — must be defined before imports
// ---------------------------------------------------------------------------

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockSendBadRequest = jest.fn();
const mockValidateBody = jest.fn();
const mockIsSystemAdmin = jest.fn();
const mockAuthenticateToken = jest.fn((_opts?: any) => (_req: any, _res: any, next: () => void) => next());

jest.mock('@mwashburn160/api-core', () => ({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  sendBadRequest: mockSendBadRequest,
  ErrorCode: {
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  },
  authenticateToken: mockAuthenticateToken,
  isSystemAdmin: mockIsSystemAdmin,
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  errorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  parseQueryInt: jest.fn((_val: unknown, defaultVal: number) => defaultVal),
  parseQueryString: jest.fn((_val: unknown) => undefined as string | undefined),
  validateBody: mockValidateBody,
}));

const mockSubscriptionFind = jest.fn();
const mockSubscriptionFindById = jest.fn();
const mockSubscriptionCountDocuments = jest.fn();

jest.mock('../src/models/subscription', () => ({
  Subscription: {
    find: mockSubscriptionFind,
    findById: mockSubscriptionFindById,
    countDocuments: mockSubscriptionCountDocuments,
  },
}));

const mockPlanFindOne = jest.fn();

jest.mock('../src/models/plan', () => ({
  Plan: { findOne: mockPlanFindOne },
}));

const mockBillingEventFind = jest.fn();
const mockBillingEventCountDocuments = jest.fn();

jest.mock('../src/models/billing-event', () => ({
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
const mockSyncTierToQuotaService = jest.fn().mockResolvedValue(true);
const mockCreateBillingEvent = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/helpers/billing-helpers', () => ({
  buildSubscriptionResponse: mockBuildSubscriptionResponse,
  syncTierToQuotaService: mockSyncTierToQuotaService,
  createBillingEvent: mockCreateBillingEvent,
}));

jest.mock('../src/validation/schemas', () => ({
  AdminSubscriptionUpdateSchema: {},
}));

import { createAdminSubscriptionRoutes } from '../src/routes/admin-subscriptions';

const router = createAdminSubscriptionRoutes();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Failed to list subscriptions', 'INTERNAL_ERROR');
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
    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'plan_changed',
      { oldPlanId: 'developer', newPlanId: 'pro' },
      'sub-1',
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
      'sub-1',
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
      'sub-1',
    );
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

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Failed to list billing events', 'INTERNAL_ERROR');
  });
});
