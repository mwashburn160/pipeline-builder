/**
 * Tests for routes/subscriptions.
 *
 * Tests the subscription CRUD routes by extracting handlers from
 * the router. Mocks Mongoose models, payment provider, and helpers.
 */

// Mocks — must be defined before imports

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockSendBadRequest = jest.fn();
const mockValidateBody = jest.fn();
const mockIsSystemAdmin = jest.fn();
const mockRequireAuth = jest.fn((_opts?: any) => (_req: any, _res: any, next: () => void) => next());

jest.mock('@mwashburn160/api-core', () => ({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  sendBadRequest: mockSendBadRequest,
  ErrorCode: {
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  },
  requireAuth: mockRequireAuth,
  requireAdmin: (_req: any, _res: any, next: () => void) => next(),
  isSystemAdmin: mockIsSystemAdmin,
  requireSystemAdmin: (_req: any, _res: any, next: () => void) => next(),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  errorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  validateBody: mockValidateBody,
}));

const mockSubscriptionFindOne = jest.fn();
const mockSubscriptionCreate = jest.fn();

jest.mock('../src/models/subscription', () => ({
  Subscription: {
    findOne: mockSubscriptionFindOne,
    create: mockSubscriptionCreate,
  },
}));

const mockPlanFindOne = jest.fn();
const mockPlanFindById = jest.fn();

jest.mock('../src/models/plan', () => ({
  Plan: {
    findOne: mockPlanFindOne,
    findById: mockPlanFindById,
  },
}));

const mockCreateCustomer = jest.fn();
const mockCreateSubscription = jest.fn();
const mockUpdateSubscription = jest.fn();
const mockCancelSubscription = jest.fn();
const mockReactivateSubscription = jest.fn();

jest.mock('../src/providers/provider-factory', () => ({
  getPaymentProvider: () => ({
    createCustomer: mockCreateCustomer,
    createSubscription: mockCreateSubscription,
    updateSubscription: mockUpdateSubscription,
    cancelSubscription: mockCancelSubscription,
    reactivateSubscription: mockReactivateSubscription,
  }),
}));

const mockBuildSubscriptionResponse = jest.fn((sub: any, planName?: string) => ({
  id: sub._id?.toString() || sub.id,
  planId: sub.planId,
  ...(planName !== undefined && { planName }),
  status: sub.status,
}));
const mockCalculatePeriodEnd = jest.fn(() => new Date('2026-04-01'));
const mockCreateBillingEvent = jest.fn().mockResolvedValue(undefined);
const mockSyncTierToQuotaService = jest.fn().mockResolvedValue(true);

jest.mock('../src/helpers/billing-helpers', () => ({
  buildSubscriptionResponse: mockBuildSubscriptionResponse,
  calculatePeriodEnd: mockCalculatePeriodEnd,
  createBillingEvent: mockCreateBillingEvent,
  syncTierToQuotaService: mockSyncTierToQuotaService,
}));

jest.mock('../src/validation/schemas', () => ({
  SubscriptionCreateSchema: {},
  SubscriptionUpdateSchema: {},
}));

import { createSubscriptionRoutes } from '../src/routes/subscriptions';

const router = createSubscriptionRoutes();

// Helpers

/**
 * Extract the last handler from a route stack (skips middleware like
 * requireAuth and requireSystemAdmin).
 */
function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  // The actual handler is the last in the stack (after auth middleware)
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
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
    orgId: 'org-1',
    planId: 'pro',
    status: 'active',
    interval: 'monthly',
    currentPeriodStart: new Date('2026-03-01'),
    currentPeriodEnd: new Date('2026-04-01'),
    cancelAtPeriodEnd: false,
    externalId: 'ext-sub-1',
    externalCustomerId: 'ext-cust-1',
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Tests

describe('GET /subscriptions', () => {
  const handler = getHandler('get', '/subscriptions');

  beforeEach(() => jest.clearAllMocks());

  it('returns current org subscription', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) });
    mockPlanFindById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Pro' }) });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      subscription: expect.objectContaining({ id: 'sub-1', planId: 'pro' }),
    });
  });

  it('returns null subscription when none exists', async () => {
    mockSubscriptionFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { subscription: null });
  });

  it('returns 400 when orgId is missing', async () => {
    const req = mockReq({ user: { sub: 'user-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on database error', async () => {
    mockSubscriptionFindOne.mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('DB down')) });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Failed to get subscription', 'INTERNAL_ERROR');
  });
});

describe('POST /subscriptions', () => {
  const handler = getHandler('post', '/subscriptions');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'pro', interval: 'monthly' } });
    mockCreateCustomer.mockResolvedValue('ext-cust-1');
    mockCreateSubscription.mockResolvedValue({ externalId: 'ext-sub-1', externalCustomerId: 'ext-cust-1' });
  });

  it('creates a subscription successfully', async () => {
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro', isActive: true });
    mockSubscriptionFindOne.mockResolvedValue(null);
    const createdSub = makeSubscription();
    mockSubscriptionCreate.mockResolvedValue(createdSub);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 201, {
      subscription: expect.objectContaining({ id: 'sub-1' }),
    });
    expect(mockSyncTierToQuotaService).toHaveBeenCalledWith('org-1', 'pro', 'Bearer tok');
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'subscription_created', expect.any(Object), expect.any(String));
  });

  it('returns 400 when orgId is missing', async () => {
    const req = mockReq({ user: { sub: 'user-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, 'Organization ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns validation error on bad body', async () => {
    mockValidateBody.mockReturnValue({ ok: false, error: 'planId is required' });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendBadRequest).toHaveBeenCalledWith(res, 'planId is required', 'VALIDATION_ERROR');
  });

  it('returns 404 when plan not found', async () => {
    mockPlanFindOne.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Plan not found', 'NOT_FOUND');
  });

  it('returns 409 when active subscription already exists', async () => {
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro' });
    mockSubscriptionFindOne.mockResolvedValue(makeSubscription());

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 409, expect.stringContaining('already has an active subscription'), 'DUPLICATE_ENTRY');
  });

  it('returns 500 on payment provider error', async () => {
    mockPlanFindOne.mockResolvedValue({ _id: 'pro', name: 'Pro', tier: 'pro' });
    mockSubscriptionFindOne.mockResolvedValue(null);
    mockCreateCustomer.mockRejectedValue(new Error('Payment API down'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Failed to create subscription', 'INTERNAL_ERROR');
  });
});

describe('PUT /subscriptions/:id', () => {
  const handler = getHandler('put', '/subscriptions/:id');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'enterprise' } });
  });

  it('updates subscription plan', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'enterprise', name: 'Enterprise', tier: 'enterprise' });
    mockUpdateSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      subscription: expect.any(Object),
    });
    expect(sub.save).toHaveBeenCalled();
  });

  it('returns 400 when neither planId nor interval provided', async () => {
    mockValidateBody.mockReturnValue({ ok: true, value: {} });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, 'At least planId or interval is required', 'VALIDATION_ERROR');
  });

  it('returns 404 when subscription not found', async () => {
    mockSubscriptionFindOne.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Active subscription not found', 'NOT_FOUND');
  });

  it('returns 404 when new plan not found', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Plan not found', 'NOT_FOUND');
  });

  it('captures correct old planId in billing event', async () => {
    const sub = makeSubscription({ planId: 'developer' });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockPlanFindOne.mockResolvedValue({ _id: 'enterprise', name: 'Enterprise', tier: 'enterprise', isActive: true });
    mockUpdateSubscription.mockResolvedValue(undefined);
    mockValidateBody.mockReturnValue({ ok: true, value: { planId: 'enterprise' } });

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockCreateBillingEvent).toHaveBeenCalledWith(
      'org-1', 'plan_changed',
      { oldPlanId: 'developer', newPlanId: 'enterprise' },
      'sub-1',
    );
  });

  it('captures correct old interval in billing event', async () => {
    const sub = makeSubscription({ interval: 'monthly' });
    mockSubscriptionFindOne.mockResolvedValue(sub);
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
});

describe('POST /subscriptions/:id/cancel', () => {
  const handler = getHandler('post', '/subscriptions/:id/cancel');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
  });

  it('cancels subscription at period end', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(sub.save).toHaveBeenCalled();
    expect(mockCancelSubscription).toHaveBeenCalledWith('ext-sub-1');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      message: expect.stringContaining('canceled'),
    }));
  });

  it('returns 404 when active subscription not found', async () => {
    mockSubscriptionFindOne.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Active subscription not found', 'NOT_FOUND');
  });

  it('returns 500 on provider error', async () => {
    const sub = makeSubscription();
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockCancelSubscription.mockRejectedValue(new Error('Provider timeout'));

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Failed to cancel subscription', 'INTERNAL_ERROR');
  });
});

describe('POST /subscriptions/:id/reactivate', () => {
  const handler = getHandler('post', '/subscriptions/:id/reactivate');

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSystemAdmin.mockReturnValue(true);
  });

  it('reactivates a canceled subscription', async () => {
    const sub = makeSubscription({ cancelAtPeriodEnd: true });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockReactivateSubscription.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(sub.cancelAtPeriodEnd).toBe(false);
    expect(sub.save).toHaveBeenCalled();
    expect(mockReactivateSubscription).toHaveBeenCalledWith('ext-sub-1');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      message: expect.stringContaining('reactivated'),
    }));
  });

  it('returns 404 when no canceled subscription found', async () => {
    mockSubscriptionFindOne.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, expect.stringContaining('No canceled subscription'), 'NOT_FOUND');
  });

  it('returns 500 on provider error', async () => {
    const sub = makeSubscription({ cancelAtPeriodEnd: true });
    mockSubscriptionFindOne.mockResolvedValue(sub);
    mockReactivateSubscription.mockRejectedValue(new Error('Network error'));

    const req = mockReq({ params: { id: 'sub-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Failed to reactivate subscription', 'INTERNAL_ERROR');
  });
});
