/**
 * Tests for billing helper functions.
 */

const mockBillingEventCreate = jest.fn();

jest.mock('../src/models/billing-event', () => ({
  BillingEvent: {
    create: mockBillingEventCreate,
  },
}));

const mockClientPut = jest.fn();

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  createSafeClient: () => ({
    put: mockClientPut,
  }),
}));

jest.mock('../src/config', () => ({
  config: {
    quotaService: { host: 'quota', port: 3000 },
  },
}));

import {
  calculatePeriodEnd,
  createBillingEvent,
  buildSubscriptionResponse,
  syncTierToQuotaService,
} from '../src/helpers/billing-helpers';

// calculatePeriodEnd

describe('calculatePeriodEnd', () => {
  it('adds 1 month for monthly interval', () => {
    const start = new Date(2026, 2, 1); // March 1, 2026 (local)
    const end = calculatePeriodEnd(start, 'monthly');
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(3); // April
    expect(end.getDate()).toBe(1);
  });

  it('adds 1 year for annual interval', () => {
    const start = new Date(2026, 2, 1); // March 1, 2026 (local)
    const end = calculatePeriodEnd(start, 'annual');
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(2); // March
  });

  it('does not mutate the input date', () => {
    const start = new Date(2026, 5, 15); // June 15, 2026 (local)
    calculatePeriodEnd(start, 'monthly');
    expect(start.getMonth()).toBe(5); // June unchanged
  });
});

// createBillingEvent

describe('createBillingEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates billing event with correct fields', async () => {
    mockBillingEventCreate.mockResolvedValue({});
    await createBillingEvent('org-1', 'plan_changed', { oldPlanId: 'pro' }, 'sub-1');
    expect(mockBillingEventCreate).toHaveBeenCalledWith({
      orgId: 'org-1',
      type: 'plan_changed',
      details: { oldPlanId: 'pro' },
      subscriptionId: 'sub-1',
    });
  });

  it('creates event without subscriptionId when not provided', async () => {
    mockBillingEventCreate.mockResolvedValue({});
    await createBillingEvent('org-1', 'subscription_created', { planId: 'pro' });
    expect(mockBillingEventCreate).toHaveBeenCalledWith({
      orgId: 'org-1',
      type: 'subscription_created',
      details: { planId: 'pro' },
      subscriptionId: undefined,
    });
  });

  it('does not throw on create failure (logs error instead)', async () => {
    mockBillingEventCreate.mockRejectedValue(new Error('DB down'));
    await expect(createBillingEvent('org-1', 'plan_changed', {})).resolves.toBeUndefined();
  });
});

// buildSubscriptionResponse

describe('buildSubscriptionResponse', () => {
  const baseSub = {
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
  };

  it('includes all required fields', () => {
    const result = buildSubscriptionResponse(baseSub, 'Pro');
    expect(result).toMatchObject({
      id: 'sub-1',
      orgId: 'org-1',
      planId: 'pro',
      planName: 'Pro',
      status: 'active',
      interval: 'monthly',
      cancelAtPeriodEnd: false,
    });
    expect(result.currentPeriodStart).toBeDefined();
    expect(result.currentPeriodEnd).toBeDefined();
    expect(result.createdAt).toBeDefined();
    expect(result.updatedAt).toBeDefined();
  });

  it('omits planName when not provided', () => {
    const result = buildSubscriptionResponse(baseSub);
    expect(result).not.toHaveProperty('planName');
  });

  it('includes tier when provided', () => {
    const result = buildSubscriptionResponse(baseSub, 'Pro', 'pro');
    expect(result.tier).toBe('pro');
  });

  it('omits tier when not provided', () => {
    const result = buildSubscriptionResponse(baseSub, 'Pro');
    expect(result).not.toHaveProperty('tier');
  });
});

// syncTierToQuotaService

describe('syncTierToQuotaService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true on success', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });
    const result = await syncTierToQuotaService('org-1', 'pro' as any, 'Bearer tok');
    expect(result).toBe(true);
  });

  it('returns false on non-success status code', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 500 });
    const result = await syncTierToQuotaService('org-1', 'pro' as any, 'Bearer tok');
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    mockClientPut.mockRejectedValue(new Error('timeout'));
    const result = await syncTierToQuotaService('org-1', 'pro' as any, 'Bearer tok');
    expect(result).toBe(false);
  });
});
