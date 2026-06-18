// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for subscription lifecycle background checker.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSyncTier = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockCreateBillingEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({
    post: jest.fn().mockResolvedValue({ statusCode: 201 }),
  }),
  getServiceAuthHeader: () => 'Bearer test-service-token',
  // Stub the scheduler but preserve run-on-start: these tests call
  // startSubscriptionLifecycleChecker() and assert the cycle's effects, so
  // start() must invoke the configured run() (the interval itself is api-core's
  // concern, tested there).
  createScheduler: (opts: { run: () => Promise<void> }) => ({
    start: () => { void opts.run(); },
    stop: () => undefined,
  }),
}));

// Pass-through tenant-context wrapper. Real runWithTenantContext lives in
// pipeline-core; we stub it so the lifecycle code calls execute synchronously
// without standing up an AsyncLocalStorage.
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  syncTierToQuotaService: (...args: unknown[]) => mockSyncTier(...args),
  createBillingEvent: (...args: unknown[]) => mockCreateBillingEvent(...args),
}));

const mockFind = jest.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

const mockPlanFindById = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ name: 'Pro', tier: 'pro' });
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: {
    findById: (...args: unknown[]) => mockPlanFindById(...args),
  },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    paymentGracePeriodDays: 7,
    renewalReminderDays: 7,
    lifecycleCheckIntervalMs: 3600000,
    messageService: { host: 'message', port: 3000 },
  },
}));

const {
  startSubscriptionLifecycleChecker,
  stopSubscriptionLifecycleChecker,
} = await import('../src/helpers/subscription-lifecycle.js');

describe('Subscription Lifecycle Checker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stopSubscriptionLifecycleChecker();
  });

  afterAll(() => {
    stopSubscriptionLifecycleChecker();
  });

  describe('startSubscriptionLifecycleChecker', () => {
    it('starts without throwing', () => {
      expect(() => startSubscriptionLifecycleChecker()).not.toThrow();
    });

    it('does not create duplicate timers on repeated calls', () => {
      startSubscriptionLifecycleChecker();
      startSubscriptionLifecycleChecker();
      // Should not throw or create multiple timers
      stopSubscriptionLifecycleChecker();
    });
  });

  describe('stopSubscriptionLifecycleChecker', () => {
    it('stops without throwing even if not started', () => {
      expect(() => stopSubscriptionLifecycleChecker()).not.toThrow();
    });
  });

  describe('grace period expiry', () => {
    it('downgrades orgs whose grace period has expired', async () => {
      const expiredSub = {
        _id: { toString: () => 'sub-1' },
        orgId: 'org-1',
        status: 'past_due',
        firstFailedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), // 8 days ago
        failedPaymentAttempts: 3,
      };

      mockFind
        .mockResolvedValueOnce([expiredSub]) // grace period query
        .mockResolvedValueOnce([]) // expired subscriptions query
        .mockResolvedValueOnce([]); // renewal reminders query

      startSubscriptionLifecycleChecker();

      // Wait for the initial async run
      await new Promise(resolve => setTimeout(resolve, 100));

      // 4th arg is subscriptionId — passed for audit correlation in the quota service.
      expect(mockSyncTier).toHaveBeenCalledWith('org-1', 'developer', '', 'sub-1');
      expect(mockCreateBillingEvent).toHaveBeenCalledWith(
        'org-1',
        'subscription_updated',
        expect.objectContaining({ reason: 'grace_period_expired' }),
        'sub-1',
      );
    });

    it('does not downgrade when no subscriptions have expired grace period', async () => {
      mockFind.mockResolvedValue([]);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncTier).not.toHaveBeenCalled();
    });
  });

  describe('expired subscription detection', () => {
    it('logs billing event for stale active subscriptions past period end', async () => {
      const staleSub = {
        _id: { toString: () => 'sub-2' },
        orgId: 'org-2',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
        cancelAtPeriodEnd: false,
      };

      mockFind
        .mockResolvedValueOnce([]) // grace period query (none expired)
        .mockResolvedValueOnce([staleSub]) // expired subscriptions query
        .mockResolvedValueOnce([]); // renewal reminders query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockCreateBillingEvent).toHaveBeenCalledWith(
        'org-2',
        'subscription_updated',
        expect.objectContaining({ reason: 'period_end_passed_without_renewal' }),
        'sub-2',
      );
    });
  });

  describe('renewal reminders', () => {
    it('sends reminder for subscriptions renewing within reminder window', async () => {
      const upcomingSub = {
        _id: { toString: () => 'sub-3' },
        orgId: 'org-3',
        planId: 'pro-plan',
        status: 'active',
        interval: 'monthly',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days from now
        metadata: {},
        save: jest.fn().mockResolvedValue(undefined),
      };

      mockFind
        .mockResolvedValueOnce([]) // grace period query
        .mockResolvedValueOnce([]) // expired subscriptions query
        .mockResolvedValueOnce([upcomingSub]); // renewal reminders query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have saved the subscription with lastRenewalReminder metadata
      expect(upcomingSub.save).toHaveBeenCalled();
    });
  });
});
