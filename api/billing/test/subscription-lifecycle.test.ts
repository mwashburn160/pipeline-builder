// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for subscription lifecycle background checker.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSyncEntitlements = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockCreateBillingEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockSyncProviderAddons = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
// The compliance-set drift leg re-drives ONLY this push (not the full sync).
const mockPushComplianceSets = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
// The EFFECTIVE feature set (tier ∪ bundles) the compliance drift leg derives its
// expected sets from. Default: no compliance features (⇒ expected sets []).
const mockEffectiveFeatureSet = jest.fn<(...args: unknown[]) => string[]>().mockReturnValue([]);

// EXPECTED entitlements the drift pass compares against. effectiveEntitlements is
// mocked so tests drive the expected side deterministically.
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
  listings: 3,
  seats: 10,
  eventRetentionDays: 30,
  doraRetentionDays: 180,
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
          ['plugins', 'pipelines', 'apiCalls', 'aiCalls', 'storageBytes', 'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs', 'listings']
            .map((t) => [t, { limit: EXPECTED_LIMITS[t] }]),
        ),
      },
    },
  },
});
const mockReadQuota = jest.fn<() => Promise<unknown>>().mockImplementation(() => Promise.resolve(okQuotaResponse()));
const mockReadSeat = jest.fn<() => Promise<unknown>>().mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { limit: EXPECTED_LIMITS.seats } } }));
// Platform feature-entitlements read. Default: the empty set, matching the
// default expected features ([] from mockEffectiveEntitlements).
const mockReadFeatures = jest.fn<() => Promise<unknown>>().mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { featureEntitlements: [] } } }));
// Compliance-service active-sets read (handshake #2). Default: empty active set,
// matching the default expected sets ([] from mockEffectiveFeatureSet) ⇒ no drift.
const mockReadCompliance = jest.fn<() => Promise<unknown>>().mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { sets: [] } } }));
// Reporting enforced-retention read. Default: matches the expected 30/180.
const okRetentionResponse = () => ({ statusCode: 200, body: { data: { eventRetentionDays: 30, doraRetentionDays: 180 } } });
const mockReadRetention = jest.fn<() => Promise<unknown>>().mockImplementation(() => Promise.resolve(okRetentionResponse()));

// Message-service POST (renewal reminders). The REAL safe client resolves `null` on
// a transport failure and a response object (possibly 4xx/5xx) otherwise.
const mockMessagePost = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ statusCode: 201 });
// Counts safe-client creations (each drift read builds its own).
let safeClientsCreated = 0;
// Scheduler factory spy — the module builds exactly ONE scheduler at import.
const mockCreateScheduler = jest.fn((opts: { run: () => Promise<void> }) => ({
  start: () => { void opts.run(); },
  stop: () => undefined,
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // Delivery rides the message service's internal notify route; report it the
  // way the real sender does (true only on a 2xx).
  sendSystemNotification: async (n: unknown, opts: unknown) => {
    const r = await mockMessagePost('/messages/internal/notify', n, opts) as { statusCode: number } | null;
    return !!r && r.statusCode >= 200 && r.statusCode < 300;
  },
  createSafeClient: () => {
    safeClientsCreated++;
    return {
      post: (...a: unknown[]) => mockMessagePost(...a),
      get: jest.fn((path: string) => {
        if (path.includes('/compliance/entitlements/')) return mockReadCompliance();
        if (path.includes('/reports/retention-sync/')) return mockReadRetention();
        if (path.includes('/feature-entitlements')) return mockReadFeatures();
        if (path.includes('/seat-usage')) return mockReadSeat();
        if (path.startsWith('/quotas/')) return mockReadQuota();
        return Promise.resolve(null);
      }),
    };
  },
  getServiceAuthHeader: () => 'Bearer test-service-token',
  // Stub the scheduler but preserve run-on-start: these tests call
  // startSubscriptionLifecycleChecker() and assert the cycle's effects, so
  // start() must invoke the configured run() (the interval itself is api-core's
  // concern, tested there).
  createScheduler: (opts: { run: () => Promise<void> }) => mockCreateScheduler(opts),
}));

// Pass-through tenant-context wrapper. Real runWithTenantContext lives in
// pipeline-core; we stub it so the lifecycle code calls execute synchronously
// without standing up an AsyncLocalStorage.
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  // The cron + entitlement-drift reader mint their service token via this helper.
  billingServiceAuth: (_orgId: string) => 'Bearer test-service-token',
  createBillingEvent: (...args: unknown[]) => mockCreateBillingEvent(...args),
  getBundleCatalog: () => [],
  // The real downstream client reads the outbound timeout from here.
  getBillingTimeout: () => 5000,
}));

// Re-driven by the provider add-on sync reconciler.
jest.unstable_mockModule('../src/helpers/addon-prune.js', () => ({
  syncProviderAddons: (...args: unknown[]) => mockSyncProviderAddons(...args),
}));

jest.unstable_mockModule('../src/helpers/entitlement-sync.js', () => ({
  syncEntitlements: (...args: unknown[]) => mockSyncEntitlements(...args),
  // Compliance-set drift leg: the expected-set derivation + the surgical re-push.
  effectiveFeatureSet: (...args: unknown[]) => mockEffectiveFeatureSet(...args),
  pushComplianceSetsToCompliance: (...args: unknown[]) => mockPushComplianceSets(...args),
  // Faithful to the real derivation: plan tier + add-ons while manageable and not
  // grace-downgraded, else the developer baseline; null on a dangling plan.
  currentSubscriptionEntitlement: async (sub: { status: string; planId: string; addons?: unknown[]; metadata?: Record<string, unknown> }) => {
    if (!['active', 'trialing', 'past_due'].includes(sub.status) || sub.metadata?.gracePeriodDowngradedAt) {
      return { tier: 'developer', addons: [] };
    }
    const plan = await mockPlanFindById(sub.planId) as { tier: string } | null;
    return plan ? { tier: plan.tier, addons: [...(sub.addons ?? [])] } : null;
  },
}));

// The drift pass's EXPECTED side: effectiveEntitlements is a spy so tests drive it.
jest.unstable_mockModule('../src/config/entitlements.js', () => ({
  effectiveEntitlements: (...args: unknown[]) => mockEffectiveEntitlements(...args),
}));

const mockFind = jest.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
const mockUpdateOne = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ modifiedCount: 1 });
// Atomic claims (grace/stale downgrade markers, reminder period key, stale-event
// dedupe). Default: the claim is won (a row matched).
const mockFindOneAndUpdate = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ _id: 'claimed' });
const mockExists = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null);
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    find: (...args: unknown[]) => mockFind(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    exists: (...args: unknown[]) => mockExists(...args),
  },
}));

const mockPlanFindById = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ name: 'Pro', tier: 'pro' });
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: {
    findById: (...args: unknown[]) => mockPlanFindById(...args),
  },
}));

// api-server: only incCounter is used (stale-reconcile outcome metric).
const mockIncCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (...args: unknown[]) => mockIncCounter(...args),
}));

// Payment provider: the stale-active reconciler calls getPaymentProvider() and
// (for non-marketplace subs) provider.getSubscription() to verify before acting.
// Default: a Stripe-like provider that reports the sub still active.
const mockGetSubscription = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ status: 'active' });
const mockGetEntitlements = jest.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
const mockProvider: {
  getSubscription?: (...a: unknown[]) => Promise<unknown>;
  getEntitlements?: (...a: unknown[]) => Promise<unknown[]>;
} = {
  getSubscription: (...a: unknown[]) => mockGetSubscription(...a),
  getEntitlements: (...a: unknown[]) => mockGetEntitlements(...a),
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
    complianceService: { host: 'compliance', port: 3000 },
    reportingService: { host: 'reporting', port: 3000 },
  },
}));

const {
  startSubscriptionLifecycleChecker,
  stopSubscriptionLifecycleChecker,
} = await import('../src/helpers/subscription-lifecycle.js');
// Captured before any beforeEach clearAllMocks wipes the import-time call.
const schedulersCreatedAtImport = mockCreateScheduler.mock.calls.length;

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
    mockReadFeatures.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { featureEntitlements: [] } } }));
    // Compliance drift defaults: expected sets [] (no compliance features) ==
    // enforced active sets [] ⇒ no compliance drift.
    mockEffectiveFeatureSet.mockReturnValue([]);
    mockReadCompliance.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { sets: [] } } }));
    mockPushComplianceSets.mockResolvedValue(true);
    mockReadRetention.mockImplementation(() => Promise.resolve(okRetentionResponse()));
    mockFindOneAndUpdate.mockResolvedValue({ _id: 'claimed' });
    mockExists.mockResolvedValue(null);
    mockMessagePost.mockResolvedValue({ statusCode: 201 });
    safeClientsCreated = 0;
  });

  afterAll(() => {
    stopSubscriptionLifecycleChecker();
  });

  describe('startSubscriptionLifecycleChecker', () => {
    it('starts without throwing', () => {
      expect(() => startSubscriptionLifecycleChecker()).not.toThrow();
    });

    it('does not create duplicate schedulers/timers on repeated calls', () => {
      // One module-level scheduler; start() only delegates to it (api-core's
      // scheduler.start is itself idempotent), so repeated starts build nothing new.
      expect(schedulersCreatedAtImport).toBe(1);
      expect(mockCreateScheduler.mock.calls.length).toBe(0); // cleared after import
      startSubscriptionLifecycleChecker();
      startSubscriptionLifecycleChecker();
      expect(mockCreateScheduler).not.toHaveBeenCalled();
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
      // Durable dedupe marker is CLAIMED atomically (before the side effects) so
      // exactly one pass downgrades and the row won't re-match.
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { '_id': expiredSub._id, 'status': 'past_due', 'metadata.gracePeriodDowngradedAt': { $exists: false } },
        { $set: { 'metadata.gracePeriodDowngradedAt': expect.any(String) } },
      );
      expect(expiredSub.metadata.gracePeriodDowngradedAt).toBeDefined();
      expect(expiredSub.save).not.toHaveBeenCalled();
    });

    it('skips the downgrade entirely when another pass already claimed the lapse', async () => {
      const expiredSub = {
        _id: { toString: () => 'sub-1' },
        orgId: 'org-1',
        status: 'past_due',
        firstFailedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        failedPaymentAttempts: 3,
        metadata: {} as Record<string, unknown>,
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };
      mockFind.mockResolvedValueOnce([expiredSub]).mockResolvedValue([]);
      mockFindOneAndUpdate.mockResolvedValueOnce(null); // lost the claim

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockCreateBillingEvent).not.toHaveBeenCalled();
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
      // Row flipped to canceled + durable marker CLAIMED atomically before the sync.
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { '_id': staleSub._id, 'status': { $in: ['active', 'trialing'] }, 'metadata.staleDowngradedAt': { $exists: false } },
        { $set: { 'status': 'canceled', 'metadata.staleDowngradedAt': expect.any(String) } },
      );
      expect(staleSub.status).toBe('canceled');
      expect(staleSub.metadata.staleDowngradedAt).toBeDefined();
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

    it('backstops a lapsed marketplace sub: no active entitlement → downgraded to developer', async () => {
      mockGetEntitlements.mockResolvedValueOnce([]); // GetEntitlements: nothing active
      const staleSub = {
        _id: { toString: () => 'sub-mkt' },
        orgId: 'org-mkt',
        status: 'active',
        externalId: 'aws_sub_cust-1',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        metadata: { provider: 'aws-marketplace', awsCustomerIdentifier: 'cust-1' } as Record<string, unknown>,
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      mockFind
        .mockResolvedValueOnce([]) // grace period query
        .mockResolvedValueOnce([staleSub]) // expired subscriptions query
        .mockResolvedValueOnce([]) // renewal reminders query
        .mockResolvedValueOnce([]); // reconcile query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verified against GetEntitlements (the customer id, never an AWS account id).
      expect(mockGetEntitlements).toHaveBeenCalledWith('cust-1');
      // No active entitlement → downgraded to developer.
      expect(mockSyncEntitlements).toHaveBeenCalledWith('org-mkt', 'developer', expect.anything(), 'sub-mkt', []);
      expect(staleSub.status).toBe('canceled');
    });

    it('leaves a still-entitled marketplace sub alone (late SNS, not a real cancel)', async () => {
      mockGetEntitlements.mockResolvedValueOnce([{ planId: 'pro', dimension: 'pro', isEntitled: true }]);
      const staleSub = {
        _id: { toString: () => 'sub-mkt2' },
        orgId: 'org-mkt2',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        metadata: { provider: 'aws-marketplace', awsCustomerIdentifier: 'cust-2' } as Record<string, unknown>,
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };
      mockFind
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([staleSub])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockGetEntitlements).toHaveBeenCalledWith('cust-2');
      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(staleSub.status).toBe('active');
    });

    it('ADVANCES a still-entitled marketplace sub to its entitlement expiry (leaves the stale scan)', async () => {
      const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      mockGetEntitlements.mockResolvedValueOnce([{ planId: 'pro', dimension: 'pro', isEntitled: true, expirationDate: expiry }]);
      const staleSub = {
        _id: { toString: () => 'sub-mkt3' },
        orgId: 'org-mkt3',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        metadata: { provider: 'aws-marketplace', awsCustomerIdentifier: 'cust-3' } as Record<string, unknown>,
      };
      mockFind.mockResolvedValueOnce([]).mockResolvedValueOnce([staleSub]).mockResolvedValue([]);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: staleSub._id }, { $set: { currentPeriodEnd: expiry } });
      expect(mockCreateBillingEvent).not.toHaveBeenCalled();
      expect(mockSyncEntitlements).not.toHaveBeenCalled();
    });

    it('records a stale-period investigation row ONCE per (sub, period, detail)', async () => {
      const staleSub = {
        _id: { toString: () => 'sub-2' },
        orgId: 'org-2',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
      };
      mockFind.mockResolvedValueOnce([]).mockResolvedValueOnce([staleSub]).mockResolvedValue([]);
      // The dedupe claim loses: this exact row was already recorded.
      mockFindOneAndUpdate.mockResolvedValueOnce(null);
      mockProvider.getSubscription = undefined;

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { '_id': staleSub._id, 'metadata.lastStalePeriodEventKey': { $ne: expect.stringContaining('|provider_read_unsupported') } },
        { $set: { 'metadata.lastStalePeriodEventKey': expect.stringContaining('|provider_read_unsupported') } },
      );
      expect(mockCreateBillingEvent).not.toHaveBeenCalled();
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
        save: jest.fn<AnyFn>().mockResolvedValue(undefined),
      };

      mockFind
        .mockResolvedValueOnce([]) // grace period query
        .mockResolvedValueOnce([]) // expired subscriptions query
        .mockResolvedValueOnce([upcomingSub]); // renewal reminders query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // The period's reminder is CLAIMED atomically before sending (no double send
      // across replicas), and the claim is kept once delivery succeeds.
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { '_id': upcomingSub._id, 'metadata.lastRenewalReminder': { $ne: expect.any(String) } },
        { $set: { 'metadata.lastRenewalReminder': expect.any(String) } },
      );
      expect(mockMessagePost).toHaveBeenCalledWith('/messages/internal/notify', expect.objectContaining({ recipientOrgId: 'org-3' }), expect.anything());
      expect(mockUpdateOne).not.toHaveBeenCalledWith(expect.objectContaining({ 'metadata.lastRenewalReminder': expect.any(String) }), expect.anything());
    });

    it('does NOT send when another pass already claimed this period', async () => {
      const upcomingSub = {
        _id: { toString: () => 'sub-3' },
        orgId: 'org-3',
        planId: 'pro-plan',
        status: 'active',
        interval: 'monthly',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        metadata: {},
      };
      mockFind.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([upcomingSub]).mockResolvedValue([]);
      mockFindOneAndUpdate.mockResolvedValueOnce(null);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockMessagePost).not.toHaveBeenCalled();
    });

    it.each([
      ['a transport failure (safe client resolves null)', null],
      ['a message-service rejection (5xx)', { statusCode: 503 }],
    ])('does NOT mark the reminder sent on %s — retried next tick', async (_label, response) => {
      const upcomingSub = {
        _id: { toString: () => 'sub-4' },
        orgId: 'org-4',
        planId: 'pro-plan',
        status: 'active',
        interval: 'monthly',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        metadata: {} as Record<string, unknown>,
        save: jest.fn<AnyFn>().mockResolvedValue(undefined),
      };
      mockMessagePost.mockResolvedValue(response);
      mockFind
        .mockResolvedValueOnce([]) // grace period query
        .mockResolvedValueOnce([]) // expired subscriptions query
        .mockResolvedValueOnce([upcomingSub]); // renewal reminders query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockMessagePost).toHaveBeenCalled();
      // The claim is RELEASED (only if still ours) so the next tick retries.
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { '_id': upcomingSub._id, 'metadata.lastRenewalReminder': expect.any(String) },
        { $unset: { 'metadata.lastRenewalReminder': '' } },
      );
    });
  });

  describe('provider add-on sync reconciliation', () => {
    it('re-drives syncProviderAddons for active subs carrying the providerAddonSyncPending marker', async () => {
      const pendingSub = {
        _id: { toString: () => 'sub-p' },
        orgId: 'org-p',
        externalId: 'ext-p',
        interval: 'monthly',
        planId: 'pro-plan',
        status: 'active',
        addons: [{ bundleId: 'seat_pack', quantity: 1 }],
        metadata: { providerAddonSyncPending: true },
      };

      // Only the provider-addon reconcile query returns the sub; the entitlement-
      // sync reconcile / grace / expired / renewal / drift queries return [].
      mockFind.mockImplementation(async (q: any) => (
        q?.['metadata.providerAddonSyncPending'] === true ? [pendingSub] : []
      ));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Re-drives from the CURRENT (reduced) add-ons; syncProviderAddons clears
      // the marker on success. subscriptionId + source threaded so the marker is
      // managed and the failure metric is labeled.
      expect(mockSyncProviderAddons).toHaveBeenCalledWith(
        'ext-p', [{ bundleId: 'seat_pack', quantity: 1 }], 'monthly', 'org-p', 'sub-p', 'reconcile',
      );
    });

    it('does not re-drive when no subscription carries the provider-sync marker', async () => {
      mockFind.mockResolvedValue([]);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncProviderAddons).not.toHaveBeenCalled();
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
      mockFind.mockImplementation(async (q: any) => (Array.isArray(q?.$and) ? [sub] : []));
    /** The completed-check stamp (lastReconciledAt set, backoff cleared). */
    const STAMPED = expect.objectContaining({
      $set: expect.objectContaining({ 'metadata.lastReconciledAt': expect.any(String) }),
      $unset: { 'metadata.driftRetryAfter': '', 'metadata.driftFailures': '' },
    });
    /** The read-failure backoff stamp (retry pushed out, failure counted). */
    const BACKED_OFF = expect.objectContaining({
      $set: { 'metadata.lastDriftAttemptAt': expect.any(String), 'metadata.driftRetryAfter': expect.any(String) },
      $inc: { 'metadata.driftFailures': 1 },
    });
    const stampedCalls = () => mockUpdateOne.mock.calls.filter((c) => (c[1] as any)?.$set?.['metadata.lastReconciledAt']);

    it('bounds the scan and gates on lastReconciledAt (per-tick cap + ~daily gate)', async () => {
      mockFind.mockResolvedValue([]); // no candidates on any query

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Drift query: manageable rows + not-yet-settled terminal rows, gated on
      // (never reconciled OR reconciled before the cutoff) AND outside any read-
      // failure backoff; OLDEST-reconciled first, capped at the DB level.
      expect(mockFind).toHaveBeenCalledWith(
        {
          $and: [
            {
              $or: [
                { status: { $in: ['active', 'trialing', 'past_due'] } },
                { 'metadata.terminalReconciledAt': { $exists: false } },
              ],
            },
            {
              $or: [
                { 'metadata.lastReconciledAt': { $exists: false } },
                { 'metadata.lastReconciledAt': { $lte: expect.any(String) } },
              ],
            },
            {
              $or: [
                { 'metadata.driftRetryAfter': { $exists: false } },
                { 'metadata.driftRetryAfter': { $lte: expect.any(String) } },
              ],
            },
          ],
        },
        null,
        { sort: { 'metadata.lastReconciledAt': 1 }, limit: 100 },
      );
    });

    it('expects a GRACE-DOWNGRADED past_due row at the developer baseline (never re-grants the paid tier)', async () => {
      onlyDriftReturns({ ...driftSub(), status: 'past_due', metadata: { gracePeriodDowngradedAt: '2026-01-01T00:00:00Z' } });

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockEffectiveEntitlements).toHaveBeenCalledWith('developer', [], []);
      expect(mockPlanFindById).not.toHaveBeenCalled();
    });

    it('scans a CANCELED row for over-entitlement and re-syncs the org down to developer', async () => {
      onlyDriftReturns({ ...driftSub(), status: 'canceled' });
      // Enforced seats still at a paid value (a missed downgrade).
      mockReadSeat.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { limit: 25 } } }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).toHaveBeenCalledWith('org-d', 'developer', 'Bearer test-service-token', 'sub-d', []);
      // Terminal rows are settled once confirmed.
      const stamp = stampedCalls()[0]?.[1] as any;
      expect(stamp.$set['metadata.terminalReconciledAt']).toEqual(expect.any(String));
    });

    it('settles a SUPERSEDED terminal row (org has a live sub) without any reads', async () => {
      onlyDriftReturns({ ...driftSub(), status: 'canceled' });
      mockExists.mockResolvedValueOnce({ _id: 'live' });

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockReadSeat).not.toHaveBeenCalled();
      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(stampedCalls()).toHaveLength(1);
    });

    it('RETENTION drift: reporting enforces a different retention → re-sync + drift metric (dimension retention)', async () => {
      onlyDriftReturns(driftSub());
      mockReadRetention.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { eventRetentionDays: 30, doraRetentionDays: 545 } } }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).toHaveBeenCalledWith('org-d', 'pro', 'Bearer test-service-token', 'sub-d', []);
      expect(mockIncCounter).toHaveBeenCalledWith('billing_entitlement_drift_total', { dimension: 'retention' });
    });

    it('RETENTION read failure → skip with BACKOFF (not stamped, no re-sync)', async () => {
      onlyDriftReturns(driftSub());
      mockReadRetention.mockImplementation(() => Promise.resolve({ statusCode: 503 }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(stampedCalls()).toHaveLength(0);
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: expect.anything() }, BACKED_OFF);
    });

    it('releases every per-call safe client the drift reads create', async () => {
      onlyDriftReturns(driftSub());

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // quota + seat + features + compliance reads all ran …
      expect(mockReadCompliance).toHaveBeenCalled();
      expect(safeClientsCreated).toBeGreaterThanOrEqual(4);
    });

    it('MATCH: enforced state equals expected → no re-sync, lastReconciledAt stamped', async () => {
      onlyDriftReturns(driftSub());

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockIncCounter).not.toHaveBeenCalledWith('billing_entitlement_drift_total', expect.anything());
      // Stamped so the sub drops out of the query for the next interval.
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'sub-d' }, STAMPED);
    });

    it('SEATS drift: enforced seats differ → re-sync + drift metric (dimension seats)', async () => {
      onlyDriftReturns(driftSub());
      // Enforced seats = 25, expected = 10.
      mockReadSeat.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { limit: 25 } } }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).toHaveBeenCalledWith('org-d', 'pro', 'Bearer test-service-token', 'sub-d', []);
      expect(mockIncCounter).toHaveBeenCalledWith('billing_entitlement_drift_total', { dimension: 'seats' });
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'sub-d' }, STAMPED);
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
                listings: { limit: 3 },
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

    it('FEATURE drift: enforced feature entitlements differ → re-sync + drift metric (dimension features)', async () => {
      onlyDriftReturns(driftSub());
      // Expected features grant `sso`; platform enforces the empty set — drift.
      mockEffectiveEntitlements.mockReturnValue({ limits: { ...EXPECTED_LIMITS }, features: ['sso'] });
      mockReadFeatures.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { featureEntitlements: [] } } }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).toHaveBeenCalledWith('org-d', 'pro', 'Bearer test-service-token', 'sub-d', []);
      expect(mockIncCounter).toHaveBeenCalledWith('billing_entitlement_drift_total', { dimension: 'features' });
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'sub-d' }, STAMPED);
    });

    it('FEATURE match is order-independent: same set, different order → no drift', async () => {
      onlyDriftReturns(driftSub());
      mockEffectiveEntitlements.mockReturnValue({ limits: { ...EXPECTED_LIMITS }, features: ['sso', 'bulk_operations'] });
      mockReadFeatures.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { featureEntitlements: ['bulk_operations', 'sso'] } } }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockIncCounter).not.toHaveBeenCalledWith('billing_entitlement_drift_total', expect.anything());
    });

    it('FEATURE read failure: platform feature read fails → skip feature compare, NO false drift', async () => {
      onlyDriftReturns(driftSub());
      // Expected features grant `sso`, but the platform feature read is unreachable
      // (null). An outage must NOT be read as "features drifted to empty".
      mockEffectiveEntitlements.mockReturnValue({ limits: { ...EXPECTED_LIMITS }, features: ['sso'] });
      mockReadFeatures.mockImplementation(() => Promise.resolve(null));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockIncCounter).not.toHaveBeenCalledWith('billing_entitlement_drift_total', expect.anything());
      // Un-stamped (read failure, not drift) — retried after a backoff.
      expect(stampedCalls()).toHaveLength(0);
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: expect.anything() }, BACKED_OFF);
    });

    it('READ FAILURE: a store read fails → skip, NO false re-sync, NOT stamped', async () => {
      onlyDriftReturns(driftSub());
      // Platform seat read returns null (unreachable) — an outage is NOT drift.
      mockReadSeat.mockImplementation(() => Promise.resolve(null));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockIncCounter).not.toHaveBeenCalledWith('billing_entitlement_drift_total', expect.anything());
      // Un-stamped — retried after a backoff.
      expect(stampedCalls()).toHaveLength(0);
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: expect.anything() }, BACKED_OFF);
    });

    it('does nothing when no subscription is due for a drift check', async () => {
      mockFind.mockResolvedValue([]);

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    it('COMPLIANCE drift: entitled sets differ from the compliance service → re-push ONLY the compliance sets + drift metric (dimension compliance)', async () => {
      onlyDriftReturns(driftSub());
      // Entitled to `standard` (via a compliance feature) but the compliance
      // service reports NO active sets — a compliance-only divergence.
      mockEffectiveFeatureSet.mockReturnValue(['compliance_standard']);
      mockReadCompliance.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { sets: [] } } }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Surgical re-push of the entitled sets (NOT the full four-target sync).
      expect(mockPushComplianceSets).toHaveBeenCalledWith('org-d', ['compliance_standard'], 'Bearer test-service-token', 'sub-d');
      expect(mockSyncEntitlements).not.toHaveBeenCalled();
      expect(mockIncCounter).toHaveBeenCalledWith('billing_entitlement_drift_total', { dimension: 'compliance' });
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'sub-d' }, STAMPED);
    });

    it('CUTOVER: an entitled-but-inactive Enterprise org (no billing event) → the periodic pass activates BOTH sets', async () => {
      onlyDriftReturns({ ...driftSub(), planId: 'ent-plan' });
      mockPlanFindById.mockResolvedValue({ name: 'Enterprise', tier: 'enterprise' });
      // Enterprise carries both compliance flags via the tier baseline; the
      // compliance service has never activated them (empty active set).
      mockEffectiveFeatureSet.mockReturnValue(['compliance_standard', 'compliance_advanced']);
      mockReadCompliance.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { sets: [] } } }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockPushComplianceSets).toHaveBeenCalledWith('org-d', ['compliance_standard', 'compliance_advanced'], 'Bearer test-service-token', 'sub-d');
      expect(mockIncCounter).toHaveBeenCalledWith('billing_entitlement_drift_total', { dimension: 'compliance' });
    });

    it('COMPLIANCE match: enforced active sets equal the entitled sets → no re-push, no metric, stamped', async () => {
      onlyDriftReturns(driftSub());
      mockEffectiveFeatureSet.mockReturnValue(['compliance_standard']);
      mockReadCompliance.mockImplementation(() => Promise.resolve({ statusCode: 200, body: { data: { sets: ['standard'] } } }));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockPushComplianceSets).not.toHaveBeenCalled();
      expect(mockIncCounter).not.toHaveBeenCalledWith('billing_entitlement_drift_total', { dimension: 'compliance' });
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'sub-d' }, STAMPED);
    });

    it('COMPLIANCE read failure: the compliance service is unreachable → skip, NO false re-push, NOT stamped', async () => {
      onlyDriftReturns(driftSub());
      mockEffectiveFeatureSet.mockReturnValue(['compliance_standard']);
      // Compliance read returns null (unreachable) — an outage is NOT drift.
      mockReadCompliance.mockImplementation(() => Promise.resolve(null));

      startSubscriptionLifecycleChecker();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockPushComplianceSets).not.toHaveBeenCalled();
      expect(mockIncCounter).not.toHaveBeenCalledWith('billing_entitlement_drift_total', { dimension: 'compliance' });
      // Un-stamped (read failure, not drift) — retried after a backoff.
      expect(stampedCalls()).toHaveLength(0);
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: expect.anything() }, BACKED_OFF);
    });
  });
});
