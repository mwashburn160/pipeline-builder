/**
 * Tests for subscription lifecycle background checker.
 */

const mockSyncTier = jest.fn().mockResolvedValue(true);
const mockCreateBillingEvent = jest.fn().mockResolvedValue(undefined);

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  createSafeClient: () => ({
    post: jest.fn().mockResolvedValue({ statusCode: 201 }),
  }),
}));

jest.mock('../src/helpers/billing-helpers', () => ({
  syncTierToQuotaService: (...args: unknown[]) => mockSyncTier(...args),
  createBillingEvent: (...args: unknown[]) => mockCreateBillingEvent(...args),
}));

const mockFind = jest.fn().mockResolvedValue([]);
jest.mock('../src/models/subscription', () => ({
  Subscription: {
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

const mockPlanFindById = jest.fn().mockResolvedValue({ name: 'Pro', tier: 'pro' });
jest.mock('../src/models/plan', () => ({
  Plan: {
    findById: (...args: unknown[]) => mockPlanFindById(...args),
  },
}));

jest.mock('../src/config', () => ({
  config: {
    paymentGracePeriodDays: 7,
    renewalReminderDays: 7,
    lifecycleCheckIntervalMs: 3600000,
    messageService: { host: 'message', port: 3000 },
  },
}));

import {
  startSubscriptionLifecycleChecker,
  stopSubscriptionLifecycleChecker,
} from '../src/helpers/subscription-lifecycle';

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
        .mockResolvedValueOnce([])           // expired subscriptions query
        .mockResolvedValueOnce([]);          // renewal reminders query

      startSubscriptionLifecycleChecker();

      // Wait for the initial async run
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncTier).toHaveBeenCalledWith('org-1', 'developer', '');
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
        .mockResolvedValueOnce([])          // grace period query (none expired)
        .mockResolvedValueOnce([staleSub])   // expired subscriptions query
        .mockResolvedValueOnce([]);          // renewal reminders query

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
        .mockResolvedValueOnce([])             // grace period query
        .mockResolvedValueOnce([])             // expired subscriptions query
        .mockResolvedValueOnce([upcomingSub]); // renewal reminders query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have saved the subscription with lastRenewalReminder metadata
      expect(upcomingSub.save).toHaveBeenCalled();
    });
  });
});
