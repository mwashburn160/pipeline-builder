// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for subscription lifecycle background checker.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSyncEntitlements = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockCreateBillingEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);

// EXPECTED entitlements the drift pass compares against. effectiveEntitlements is
// mocked (billing-helpers) so tests drive the expected side deterministically.
const EXPECTED_LIMITS: Record<string, number> = {
  plugins: 50,
  pipelines: 5,
  apiCalls: 25000,
  aiCalls: 50,
  storageBytes: 2147483648,
  dashboards: 20,
  alertRules: 50,
  alertDestinations: 10,
  idpConfigs: 1,
  seats: 10,
};
const mockEffectiveEntitlements = jest.fn<(...args: unknown[]) => { limits: Record<string, number>; features: string[] }>()
  .mockReturnValue({ limits: { ...EXPECTED_LIMITS }, features: [] });

// ACTUAL enforced-state reads (quota + platform seat) the drift pass performs via
// createSafeClient.get. Each test sets these to a full response, a non-2xx, or a
// thrown error (fail-soft). Default: enforced state that MATCHES EXPECTED_LIMITS.
const okQuotaResponse = () => ({
  statusCode: 200,
  body: {
    data: {
      quota: {
        quotas: Object.fromEntries(
          ['plugins', 'pipelines', 'apiCalls', 'aiCalls', 'storageBytes', 'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs']
            .map((t) => [t, { limit: EXPECTED_LIMITS[t] }]),
        ),
      },
    },
  },
});
const mockReadQuota = jest.fn<() => Promise<unknown>>().mockImplementation(() => Promise.resolve(okQuotaResponse()));
const mockReadSeat = jest.fn<() => Promise<unknown>>().mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { limit: EXPECTED_LIMITS.seats } } }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({
    post: jest.fn().mockResolvedValue({ statusCode: 201 }),
    get: jest.fn((path: string) => {
      if (path.includes('/seat-usage')) return mockReadSeat();
      if (path.startsWith('/quotas/')) return mockReadQuota();
      return Promise.resolve(null);
    }),
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
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  syncEntitlements: (...args: unknown[]) => mockSyncEntitlements(...args),
  createBillingEvent: (...args: unknown[]) => mockCreateBillingEvent(...args),
  // Consumed by the drift pass (EXPECTED side) + the real entitlement-drift
  // read helper (timeout). effectiveEntitlements is a spy so tests drive expected.
  effectiveEntitlements: (...args: unknown[]) => mockEffectiveEntitlements(...args),
  getBundleCatalog: () => [],
  getBillingTimeout: () => 5000,
}));

const mockFind = jest.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
const mockUpdateOne = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ modifiedCount: 1 });
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    find: (...args: unknown[]) => mockFind(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

const mockPlanFindById = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ name: 'Pro', tier: 'pro' });
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: {
    findById: (...args: unknown[]) => mockPlanFindById(...args),
  },
}));

// api-server: only incCounter is used (stale-reconcile outcome metric).
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: (...args: unknown[]) => mockIncCounter(...args),
}));

// Payment provider: the stale-active reconciler calls getPaymentProvider() and
// (for non-marketplace subs) provider.getSubscription() to verify before acting.
// Default: a Stripe-like provider that reports the sub still active.
const mockGetSubscription = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ status: 'active' });
const mockProvider: { getSubscription?: (...a: unknown[]) => Promise<unknown> } = {
  getSubscription: (...a: unknown[]) => mockGetSubscription(...a),
};
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => mockProvider,
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    paymentGracePeriodDays: 7,
    renewalReminderDays: 7,
    lifecycleCheckIntervalMs: 3600000,
    entitlementDriftMaxPerTick: 100,
    entitlementDriftIntervalMs: 86400000,
    messageService: { host: 'message', port: 3000 },
    quotaService: { host: 'quota', port: 3000 },
    platformService: { host: 'platform', port: 3000 },
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
    // Restore the default provider shape (some tests null out getSubscription).
    mockProvider.getSubscription = (...a: unknown[]) => mockGetSubscription(...a);
    mockGetSubscription.mockResolvedValue({ status: 'active' });
    // Restore drift-pass defaults: EXPECTED == ACTUAL (no drift), reads succeed.
    // (clearAllMocks clears call data, not implementations set by prior tests.)
    mockPlanFindById.mockResolvedValue({ name: 'Pro', tier: 'pro' });
    mockEffectiveEntitlements.mockReturnValue({ limits: { ...EXPECTED_LIMITS }, features: [] });
    mockReadQuota.mockImplementation(() => Promise.resolve(okQuotaResponse()));
    mockReadSeat.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { limit: EXPECTED_LIMITS.seats } } }));
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
        metadata: {} as Record<string, unknown>,
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      mockFind
        .mockResolvedValueOnce([expiredSub]) // grace period query
        .mockResolvedValueOnce([]) // expired subscriptions query
        .mockResolvedValueOnce([]); // renewal reminders query

      startSubscriptionLifecycleChecker();

      // Wait for the initial async run
      await new Promise(resolve => setTimeout(resolve, 100));

      // Routes through syncEntitlements (5 args incl. empty addons) with a real
      // service-auth header, so the seat leg + sync-failure metric also fire.
      // 4th arg is subscriptionId — passed for audit correlation.
      expect(mockSyncEntitlements).toHaveBeenCalledWith('org-1', 'developer', 'Bearer test-service-token', 'sub-1', []);
      expect(mockCreateBillingEvent).toHaveBeenCalledWith(
        'org-1',
        'subscription_updated',
        expect.objectContaining({ reason: 'grace_period_expired' }),
        'sub-1',
      );
      // System/cron path: NO user actor is fabricated — actorId (5th arg) is
      // absent/undefined on lifecycle-driven billing events.
      const graceCall = mockCreateBillingEvent.mock.calls.find(
        (c) => c[2] && (c[2] as { reason?: string }).reason === 'grace_period_expired',
      );
      expect(graceCall?.[4]).toBeUndefined();
      // Durable dedupe marker is stamped + persisted so the row won't re-match.
      expect(expiredSub.metadata.gracePeriodDowngradedAt).toBeDefined();
      expect(expiredSub.save).toHaveBeenCalledTimes(1);
    });

    it('excludes already-downgraded rows from the grace-period query (durable dedupe)', async () => {
      mockFind.mockResolvedValue([]);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // The find filter must exclude subs already carrying the downgrade marker.
      expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({
        'status': 'past_due',
        'metadata.gracePeriodDowngradedAt': { $exists: false },
      }));
    });

    it('does NOT re-downgrade or re-emit on a SECOND tick (idempotent)', async () => {
      const expiredSub = {
        _id: { toString: () => 'sub-1' },
        orgId: 'org-1',
        status: 'past_due',
        firstFailedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        failedPaymentAttempts: 3,
        metadata: {} as Record<string, unknown>,
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      // Emulate the Mongo dedupe filter: the grace-period query only returns the
      // sub while it lacks the marker. Once the first tick stamps + saves it, the
      // query excludes it — exactly what `metadata.gracePeriodDowngradedAt:
      // {$exists:false}` does in the real store.
      mockFind.mockImplementation(async (q: any) => {
        if (q?.status === 'past_due') {
          return expiredSub.metadata.gracePeriodDowngradedAt ? [] : [expiredSub];
        }
        return []; // expired-subscription + renewal-reminder queries
      });

      // Tick 1 — downgrades once.
      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));
      // Tick 2 — the marked row is filtered out, so no repeat.
      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).toHaveBeenCalledTimes(1);
      expect(mockCreateBillingEvent).toHaveBeenCalledTimes(1);
      expect(expiredSub.save).toHaveBeenCalledTimes(1);
    });

    it('does not downgrade when no subscriptions have expired grace period', async () => {
      mockFind.mockResolvedValue([]);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
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
      // No provider handle → verified only as "for investigation", never downgraded.
      expect(mockSyncEntitlements).not.toHaveBeenCalled();
    });

    it('downgrades a stale-active sub the provider reports CANCELED (missed cancel webhook)', async () => {
      const staleSub = {
        _id: { toString: () => 'sub-cancel' },
        orgId: 'org-cancel',
        status: 'active',
        externalId: 'sub_stripe_gone',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        metadata: {} as Record<string, unknown>,
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      mockFind
        .mockResolvedValueOnce([]) // grace period query
        .mockResolvedValueOnce([staleSub]) // expired subscriptions query
        .mockResolvedValueOnce([]) // renewal reminders query
        .mockResolvedValueOnce([]); // reconcile query
      mockGetSubscription.mockResolvedValue({ status: 'canceled' });

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Provider-verified gone → downgrade to developer with empty add-ons.
      expect(mockGetSubscription).toHaveBeenCalledWith('sub_stripe_gone');
      expect(mockSyncEntitlements).toHaveBeenCalledWith(
        'org-cancel', 'developer', 'Bearer test-service-token', 'sub-cancel', [],
      );
      expect(mockCreateBillingEvent).toHaveBeenCalledWith(
        'org-cancel',
        'subscription_canceled',
        expect.objectContaining({ reason: 'provider_verified_cancel_missed_webhook' }),
        'sub-cancel',
      );
      // Local row flipped to canceled + durable marker stamped, then saved.
      expect(staleSub.status).toBe('canceled');
      expect(staleSub.metadata.staleDowngradedAt).toBeDefined();
      expect(staleSub.save).toHaveBeenCalledTimes(1);
      expect(mockIncCounter).toHaveBeenCalledWith(
        'billing_stale_subscription_reconciled_total', { outcome: 'downgraded' },
      );
    });

    it('does NOT downgrade a stale-active sub the provider reports RENEWED (late webhook)', async () => {
      const future = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
      const staleSub = {
        _id: { toString: () => 'sub-renew' },
        orgId: 'org-renew',
        status: 'active',
        externalId: 'sub_stripe_live',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        metadata: {} as Record<string, unknown>,
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      mockFind
        .mockResolvedValueOnce([]) // grace period query
        .mockResolvedValueOnce([staleSub]) // expired subscriptions query
        .mockResolvedValueOnce([]) // renewal reminders query
        .mockResolvedValueOnce([]); // reconcile query
      mockGetSubscription.mockResolvedValue({ status: 'active', currentPeriodEnd: future });

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Period advanced locally; NO downgrade.
      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(staleSub.currentPeriodEnd).toBe(future);
      expect(staleSub.status).toBe('active');
      expect(staleSub.save).toHaveBeenCalledTimes(1);
      expect(mockCreateBillingEvent).toHaveBeenCalledWith(
        'org-renew',
        'subscription_updated',
        expect.objectContaining({ reason: 'provider_verified_renewal_late_webhook' }),
        'sub-renew',
      );
      expect(mockIncCounter).toHaveBeenCalledWith(
        'billing_stale_subscription_reconciled_total', { outcome: 'renewed' },
      );
    });

    it('skips marketplace subs (SNS-driven) — never provider-verifies or downgrades', async () => {
      const staleSub = {
        _id: { toString: () => 'sub-mkt' },
        orgId: 'org-mkt',
        status: 'active',
        externalId: 'aws_sub_cust-1',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        metadata: { provider: 'aws-marketplace' } as Record<string, unknown>,
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      mockFind
        .mockResolvedValueOnce([]) // grace period query
        .mockResolvedValueOnce([staleSub]) // expired subscriptions query
        .mockResolvedValueOnce([]) // renewal reminders query
        .mockResolvedValueOnce([]); // reconcile query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockGetSubscription).not.toHaveBeenCalled();
      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockCreateBillingEvent).toHaveBeenCalledWith(
        'org-mkt',
        'subscription_updated',
        expect.objectContaining({ reason: 'period_end_passed_without_renewal', detail: 'marketplace_sns_driven' }),
        'sub-mkt',
      );
    });

    it('does NOT downgrade when the provider lookup throws (transient) — retries next tick', async () => {
      const staleSub = {
        _id: { toString: () => 'sub-err' },
        orgId: 'org-err',
        status: 'active',
        externalId: 'sub_stripe_x',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        metadata: {} as Record<string, unknown>,
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      mockFind
        .mockResolvedValueOnce([]) // grace period query
        .mockResolvedValueOnce([staleSub]) // expired subscriptions query
        .mockResolvedValueOnce([]) // renewal reminders query
        .mockResolvedValueOnce([]); // reconcile query
      mockGetSubscription.mockRejectedValue(new Error('stripe timeout'));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(staleSub.status).toBe('active');
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

  describe('entitlement sync reconciliation', () => {
    it('re-drives syncEntitlements for active subs carrying the pending marker', async () => {
      const pendingSub = {
        _id: { toString: () => 'sub-9' },
        orgId: 'org-9',
        planId: 'pro-plan',
        status: 'active',
        addons: [{ bundleId: 'seat_pack', quantity: 2 }],
        metadata: { entitlementSyncPending: true },
      };

      // Only the reconcile query (keyed on the pending marker) returns the sub;
      // the grace / expired / renewal queries return [].
      mockFind.mockImplementation(async (q: any) => (
        q?.['metadata.entitlementSyncPending'] === true ? [pendingSub] : []
      ));
      mockPlanFindById.mockResolvedValue({ name: 'Pro', tier: 'pro' });

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Re-drives the sub's effective tier + current add-ons; syncEntitlements
      // clears the marker on success.
      expect(mockSyncEntitlements).toHaveBeenCalledWith(
        'org-9', 'pro', 'Bearer test-service-token', 'sub-9',
        [{ bundleId: 'seat_pack', quantity: 2 }],
      );
    });

    it('does not re-sync when no subscription carries the pending marker', async () => {
      mockFind.mockResolvedValue([]); // every query, incl. the reconcile query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
    });

    it('skips a pending sub whose plan no longer exists (no sync attempted)', async () => {
      const pendingSub = {
        _id: { toString: () => 'sub-10' },
        orgId: 'org-10',
        planId: 'ghost-plan',
        status: 'active',
        addons: [],
        metadata: { entitlementSyncPending: true },
      };
      mockFind.mockImplementation(async (q: any) => (
        q?.['metadata.entitlementSyncPending'] === true ? [pendingSub] : []
      ));
      mockPlanFindById.mockResolvedValue(null);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
    });
  });

  describe('cross-store entitlement-drift reconciliation', () => {
    const driftSub = () => ({
      _id: { toString: () => 'sub-d' },
      orgId: 'org-d',
      planId: 'pro-plan',
      status: 'active',
      addons: [] as Array<{ bundleId: string; quantity: number }>,
      metadata: {} as Record<string, unknown>,
    });

    // Only the drift query (the one carrying `$or` on lastReconciledAt) returns
    // the sub; every earlier leg's query returns [].
    const onlyDriftReturns = (sub: unknown) =>
      mockFind.mockImplementation(async (q: any) => (Array.isArray(q?.$or) ? [sub] : []));

    it('bounds the scan and gates on lastReconciledAt (per-tick cap + ~daily gate)', async () => {
      mockFind.mockResolvedValue([]); // no candidates on any query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Drift query: ACTIVE + (never reconciled OR reconciled before the cutoff),
      // capped at the per-tick bound at the DB level.
      expect(mockFind).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
          $or: [
            { 'metadata.lastReconciledAt': { $exists: false } },
            { 'metadata.lastReconciledAt': { $lte: expect.any(String) } },
          ],
        }),
        null,
        { limit: 100 },
      );
    });

    it('MATCH: enforced state equals expected → no re-sync, lastReconciledAt stamped', async () => {
      onlyDriftReturns(driftSub());

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockIncCounter).not.toHaveBeenCalledWith('billing_entitlement_drift_total', expect.anything());
      // Stamped so the sub drops out of the query for the next interval.
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { _id: 'sub-d' },
        { $set: { 'metadata.lastReconciledAt': expect.any(String) } },
      );
    });

    it('SEATS drift: enforced seats differ → re-sync + drift metric (dimension seats)', async () => {
      onlyDriftReturns(driftSub());
      // Enforced seats = 25, expected = 10.
      mockReadSeat.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { limit: 25 } } }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).toHaveBeenCalledWith('org-d', 'pro', 'Bearer test-service-token', 'sub-d', []);
      expect(mockIncCounter).toHaveBeenCalledWith('billing_entitlement_drift_total', { dimension: 'seats' });
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { _id: 'sub-d' },
        { $set: { 'metadata.lastReconciledAt': expect.any(String) } },
      );
    });

    it('QUOTA-LIMIT drift: an enforced quota limit differs → re-sync + drift metric (dimension quota)', async () => {
      onlyDriftReturns(driftSub());
      // Enforced plugins limit = 999, expected = 50.
      mockReadQuota.mockImplementation(() => Promise.resolve({
        statusCode: 200,
        body: {
          data: {
            quota: {
              quotas: {
                plugins: { limit: 999 },
                pipelines: { limit: 5 },
                apiCalls: { limit: 25000 },
                aiCalls: { limit: 50 },
                storageBytes: { limit: 2147483648 },
                dashboards: { limit: 20 },
                alertRules: { limit: 50 },
                alertDestinations: { limit: 10 },
                idpConfigs: { limit: 1 },
              },
            },
          },
        },
      }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).toHaveBeenCalledWith('org-d', 'pro', 'Bearer test-service-token', 'sub-d', []);
      expect(mockIncCounter).toHaveBeenCalledWith('billing_entitlement_drift_total', { dimension: 'quota' });
    });

    it('READ FAILURE: a store read fails → skip, NO false re-sync, NOT stamped', async () => {
      onlyDriftReturns(driftSub());
      // Platform seat read returns null (unreachable) — an outage is NOT drift.
      mockReadSeat.mockImplementation(() => Promise.resolve(null));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockIncCounter).not.toHaveBeenCalledWith('billing_entitlement_drift_total', expect.anything());
      // Un-stamped so it's retried next tick.
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    it('does nothing when no subscription is due for a drift check', async () => {
      mockFind.mockResolvedValue([]);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });
  });
});
