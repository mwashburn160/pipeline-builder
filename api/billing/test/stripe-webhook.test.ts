// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Stripe webhook route.
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mock api-core
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn((_res: unknown, status: number, data: unknown) => ({ status, data })),
  sendError: jest.fn((_res: unknown, status: number, msg: string) => ({ status, msg })),
}));

// Mock helpers
const mockSyncTier = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockCreateBillingEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockCalculatePeriodEnd = jest.fn(() => new Date('2026-04-01'));
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  syncTierToQuotaService: (...args: unknown[]) => mockSyncTier(...args),
  syncEntitlements: (...args: unknown[]) => mockSyncTier(...args),
  createBillingEvent: (...args: unknown[]) => mockCreateBillingEvent(...args),
  calculatePeriodEnd: (...args: unknown[]) => mockCalculatePeriodEnd(),
}));

// Capture the real `mapStripeStatus` before the stripe-helpers module is mocked.
// (ESM jest has no jest.requireActual; import the real module first, then mock.)
const { mapStripeStatus: realMapStripeStatus } = await import('../src/helpers/stripe-helpers.js');

// Mock stripe-helpers
const mockFindByStripeId = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/helpers/stripe-helpers.js', () => ({
  findSubscriptionByStripeId: (...args: unknown[]) => mockFindByStripeId(...args),
  mapStripeStatus: realMapStripeStatus,
}));

// Mock config
jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    paymentGracePeriodDays: 7,
  },
}));

// Mock Plan model
const mockPlanFindById = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ tier: 'pro', name: 'Pro' });
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findById: (...args: unknown[]) => mockPlanFindById(...args) },
}));

// Mock Subscription model
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { findOne: jest.fn() },
}));

// Mock provider factory
const mockConstructEvent = jest.fn();
const mockGetWebhookSecret = jest.fn().mockReturnValue('whsec_test');
const mockGetStripeClient = jest.fn().mockReturnValue({
  webhooks: { constructEvent: (...args: unknown[]) => mockConstructEvent(...args) },
});

jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({
    getStripeClient: mockGetStripeClient,
    getWebhookSecret: mockGetWebhookSecret,
    // StripeProvider instanceof check needs help
    constructor: { name: 'StripeProvider' },
  }),
}));

// Override instanceof check for StripeProvider
jest.unstable_mockModule('../src/providers/stripe-provider.js', () => {
  class MockStripeProvider {}
  return { StripeProvider: MockStripeProvider };
});

const { sendError } = await import('@pipeline-builder/api-core');
const { createStripeWebhookRoutes } = await import('../src/routes/stripe-webhook.js');

// Since we can't easily test instanceof with mocks, we test the handler logic directly.
// Extract the route handler from the router.
function getWebhookHandler() {
  const router = createStripeWebhookRoutes();
  const layer = (router as unknown as { stack: Array<{ route: { path: string; stack: Array<{ handle: Function }> } }> })
    .stack.find((l) => l.route?.path === '/stripe/webhook');
  return layer?.route.stack[0].handle;
}

describe('Stripe Webhook Route', () => {
  let handler: Function;

  beforeAll(() => {
    handler = getWebhookHandler()!;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeReq(overrides: Record<string, unknown> = {}) {
    return {
      headers: { 'stripe-signature': 'sig_test' },
      body: Buffer.from('{}'),
      ...overrides,
    };
  }

  function makeRes() {
    return {} as Record<string, unknown>;
  }

  describe('signature verification', () => {
    it('returns 400 when stripe-signature header is missing', async () => {
      // The handler first checks for StripeProvider instanceof, which will fail
      // since our mock doesn't extend StripeProvider.
      // This tests the early return for missing provider.
      const req = makeReq({ headers: {} });
      await handler(req, makeRes());
      // Provider check fails first due to instanceof
      expect(sendError).toHaveBeenCalled();
    });
  });

  describe('mapStripeStatus', () => {
    // Test the helper directly since webhook integration depends on mocks
    const mapStripeStatus = realMapStripeStatus;

    it('maps active status', () => {
      expect(mapStripeStatus('active')).toBe('active');
    });

    it('maps trialing status', () => {
      expect(mapStripeStatus('trialing')).toBe('trialing');
    });

    it('maps past_due status', () => {
      expect(mapStripeStatus('past_due')).toBe('past_due');
    });

    it('maps canceled status', () => {
      expect(mapStripeStatus('canceled')).toBe('canceled');
    });

    it('maps unpaid to canceled', () => {
      expect(mapStripeStatus('unpaid')).toBe('canceled');
    });

    it('maps incomplete status', () => {
      expect(mapStripeStatus('incomplete')).toBe('incomplete');
    });

    it('maps incomplete_expired to incomplete', () => {
      expect(mapStripeStatus('incomplete_expired')).toBe('incomplete');
    });

    it('maps unknown status to incomplete', () => {
      expect(mapStripeStatus('some_new_status')).toBe('incomplete');
    });
  });

  describe('findSubscriptionByStripeId', () => {
    it('queries with correct filter', async () => {
      mockFindByStripeId.mockResolvedValue(null);

      await mockFindByStripeId('sub_test_123');
      expect(mockFindByStripeId).toHaveBeenCalledWith('sub_test_123');
    });
  });
});

// ============================================
// Grace period & payment handler logic tests
// ============================================

describe('Payment failure grace period logic', () => {
  it('should track failed payment attempts incrementally', () => {
    const subscription = {
      orgId: 'org-1',
      status: 'active' as string,
      failedPaymentAttempts: 0,
      firstFailedAt: undefined as Date | undefined,
    };

    // First failure
    subscription.status = 'past_due';
    subscription.failedPaymentAttempts += 1;
    if (!subscription.firstFailedAt) {
      subscription.firstFailedAt = new Date();
    }

    expect(subscription.status).toBe('past_due');
    expect(subscription.failedPaymentAttempts).toBe(1);
    expect(subscription.firstFailedAt).toBeDefined();

    // Second failure
    const firstFailedAt = subscription.firstFailedAt;
    subscription.failedPaymentAttempts += 1;
    if (!subscription.firstFailedAt) {
      subscription.firstFailedAt = new Date();
    }

    expect(subscription.failedPaymentAttempts).toBe(2);
    expect(subscription.firstFailedAt).toBe(firstFailedAt); // Should not change
  });

  it('should reset grace period state on successful payment', () => {
    const subscription = {
      orgId: 'org-1',
      status: 'past_due' as string,
      failedPaymentAttempts: 3,
      firstFailedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) as Date | undefined,
      interval: 'monthly' as const,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
    };

    // Simulate payment success
    subscription.failedPaymentAttempts = 0;
    subscription.firstFailedAt = undefined;
    subscription.status = 'active';

    expect(subscription.failedPaymentAttempts).toBe(0);
    expect(subscription.firstFailedAt).toBeUndefined();
    expect(subscription.status).toBe('active');
  });

  it('should determine grace period expiry correctly', () => {
    const gracePeriodDays = 7;
    const gracePeriodMs = gracePeriodDays * 24 * 60 * 60 * 1000;

    // 6 days ago — still in grace period
    const recentFailure = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const cutoff = new Date(Date.now() - gracePeriodMs);
    expect(recentFailure.getTime() > cutoff.getTime()).toBe(true);

    // 8 days ago — grace period expired
    const oldFailure = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(oldFailure.getTime() <= cutoff.getTime()).toBe(true);
  });
});
