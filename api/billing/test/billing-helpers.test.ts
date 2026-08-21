// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for billing helper functions.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockBillingEventCreate = jest.fn();

jest.unstable_mockModule('../src/models/billing-event.js', () => ({
  BillingEvent: {
    create: mockBillingEventCreate,
  },
}));

// syncEntitlements stamps/clears a durable `metadata.entitlementSyncPending`
// marker on the Subscription so the lifecycle reconciler can re-drive a failed
// sync. Mock updateOne so we can assert the $set/$unset the marker path issues.
const mockSubscriptionUpdateOne = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ modifiedCount: 1 });
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    updateOne: (...args: unknown[]) => mockSubscriptionUpdateOne(...args),
  },
}));

// billing-helpers now imports the provider factory + service audit client (for the
// auto-prune line-item removal). Stub both so no real Stripe/AWS SDK is loaded.
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({ syncAddons: jest.fn() }),
}));
jest.unstable_mockModule('../src/services/audit.js', () => ({
  getAuditClient: () => ({ record: jest.fn() }),
}));

const mockClientPut = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({
    put: mockClientPut,
  }),
  // api-server's app-factory wires this at module load to inject the metrics
  // counter into api-core helpers; tests just need it to be callable.
  setCounterEmitter: jest.fn(),
  getServiceAuthHeader: jest.fn(() => 'Bearer test-service'),
}));

// Stub api-server so its idempotency-middleware + app-factory don't try to
// initialize a real Prometheus registry at module load.
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', async () => {
  const get = (section: string) => {
    if (section === 'server') return { services: { billingTimeout: 5000 } };
    // Phase 8 retention bundles — getBundleCatalog() reads Config.get('billing').bundles;
    // the retention leg sums these grants onto the tier baseline. `dora_history_pack`
    // grants +365 dora days (base 180 → 545); `retention_pack` grants +90 event days.
    if (section === 'billing') {
      return {
        bundles: [
          { id: 'retention_pack', name: 'Retention Pack', description: '', grants: { eventRetentionDays: 90 }, prices: { monthly: 1500, annual: 15000 }, stackable: true, availableForTiers: ['developer', 'pro', 'team', 'enterprise'], isActive: true, sortOrder: 10 },
          { id: 'dora_history_pack', name: 'DORA History Pack', description: '', grants: { doraRetentionDays: 365 }, prices: { monthly: 3000, annual: 30000 }, stackable: true, availableForTiers: ['developer', 'pro', 'team', 'enterprise'], isActive: true, sortOrder: 11 },
          // Compliance content bundles — pure-feature (no quota grants); the
          // compliance sync leg derives its `sets` from these granted flags.
          { id: 'compliance_standard', name: 'Standard Compliance', description: '', grants: {}, features: ['compliance_standard'], prices: { monthly: 2990, annual: 29900 }, stackable: false, availableForTiers: ['developer', 'pro', 'team'], isActive: true, sortOrder: 12 },
          { id: 'compliance_advanced', name: 'Advanced Compliance', description: '', grants: {}, features: ['compliance_advanced'], prices: { monthly: 9990, annual: 99900 }, stackable: false, availableForTiers: ['developer', 'pro', 'team'], requires: ['compliance_standard'], isActive: true, sortOrder: 13 },
        ],
      };
    }
    return {};
  };
  // `effectiveEntitlements` moved to pipeline-core; billing-helpers imports it
  // from the barrel (which this suite mocks). Pull in the REAL implementation
  // from its leaf module — it depends only on the (mocked) api-core
  // `getTierLimits`, so the bundle math runs against the same base limits the
  // suite already asserts on, and no heavy pipeline-core graph loads.
  const { effectiveEntitlements } = await import(
    '@pipeline-builder/pipeline-core/lib/config/entitlements.js'
  );
  return {
    Config: { get, getAny: get },
    effectiveEntitlements,
    // billing-helpers imports incCounter from api-server, whose
    // idempotency-middleware reads these at module load.
    CoreConstants: {
      IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000,
      IDEMPOTENCY_TTL_MS: 300_000,
      IDEMPOTENCY_MAX_STORE_SIZE: 10_000,
    },
  };
});

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quotaService: { host: 'quota', port: 3000 },
    platformService: { host: 'platform', port: 3000 },
    reportingService: { host: 'reporting', port: 3000 },
    complianceService: { host: 'compliance', port: 3000 },
  },
}));

const {
  calculatePeriodEnd,
  createBillingEvent,
  buildSubscriptionResponse,
  syncTierToQuotaService,
  syncEntitlements,
  effectiveEntitlements,
} = await import('../src/helpers/billing-helpers.js');

// effectiveEntitlements — bundle math

describe('effectiveEntitlements', () => {
  const bundles = [
    { id: 'seat_pack', name: 'Seat Pack', description: '', grants: { seats: 5 }, prices: { monthly: 2500, annual: 25000 }, stackable: true, availableForTiers: ['pro'], isActive: true, sortOrder: 0 },
    { id: 'pipeline_pack', name: 'Pipeline Pack', description: '', grants: { pipelines: 10 }, prices: { monthly: 1500, annual: 15000 }, stackable: true, availableForTiers: ['pro'], isActive: true, sortOrder: 1 },
    { id: 'audit_log', name: 'Audit Log', description: '', grants: {}, features: ['audit_log'], prices: { monthly: 2000, annual: 20000 }, stackable: false, availableForTiers: ['pro'], isActive: true, sortOrder: 2 },
  ] as never[];

  it('adds stacked grants (3× seat_pack ⇒ +15 seats over the base 10)', () => {
    const { limits } = effectiveEntitlements('developer', [{ bundleId: 'seat_pack', quantity: 3 }], bundles);
    expect(limits.seats).toBe(10 + 15); // mock base seats = 10
  });

  it('sums grants across different bundles', () => {
    const { limits } = effectiveEntitlements('developer', [
      { bundleId: 'seat_pack', quantity: 1 },
      { bundleId: 'pipeline_pack', quantity: 2 },
    ], bundles);
    expect(limits.seats).toBe(15);
    expect(limits.pipelines).toBe(5 + 20); // mock base pipelines = 5
  });

  it('unions feature-bundle flags and ignores unknown bundles', () => {
    const { limits, features } = effectiveEntitlements('developer', [
      { bundleId: 'audit_log', quantity: 1 },
      { bundleId: 'nope', quantity: 5 },
    ], bundles);
    expect(features).toContain('audit_log');
    expect(limits.seats).toBe(10); // unchanged
  });
});

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

  it('persists actorId when the caller supplies one (request-context attribution)', async () => {
    mockBillingEventCreate.mockResolvedValue({});
    await createBillingEvent('org-1', 'plan_changed', { oldPlanId: 'pro' }, 'sub-1', 'user-9');
    expect(mockBillingEventCreate).toHaveBeenCalledWith({
      orgId: 'org-1',
      type: 'plan_changed',
      details: { oldPlanId: 'pro' },
      subscriptionId: 'sub-1',
      actorId: 'user-9',
    });
  });

  it('leaves actorId undefined for system/non-request paths (no fabricated actor)', async () => {
    mockBillingEventCreate.mockResolvedValue({});
    await createBillingEvent('org-1', 'payment_succeeded', { amount: 100 }, 'sub-1');
    const arg = mockBillingEventCreate.mock.calls[0][0] as { actorId?: string };
    expect(arg.actorId).toBeUndefined();
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

// syncEntitlements — durable "sync dirty" marker (FIX 2)

describe('syncEntitlements entitlementSyncPending marker', () => {
  beforeEach(() => jest.clearAllMocks());

  it('clears the marker (unset) when BOTH legs succeed', async () => {
    // Both quota + platform legs go through the same mocked client.put.
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(true);
    expect(mockSubscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sub-1' },
      { $unset: { 'metadata.entitlementSyncPending': '' } },
    );
  });

  it('sets the marker when a leg fails (fail-open, still returns false)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 500 });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    expect(mockSubscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sub-1' },
      { $set: { 'metadata.entitlementSyncPending': true } },
    );
  });

  it('does not touch the marker when no subscriptionId is supplied', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok');

    expect(mockSubscriptionUpdateOne).not.toHaveBeenCalled();
  });

  it('never throws even if the marker write fails (preserves fail-open contract)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });
    mockSubscriptionUpdateOne.mockRejectedValueOnce(new Error('mongo down'));

    await expect(syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1')).resolves.toBe(true);
  });

  it('pushes the account tier in the seat-limit body so a downgrade invalidates platform tokens', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    // The seat-limit leg (PUT /organization/:id/seat-limit) must carry `tier`.
    const seatCall = mockClientPut.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('/seat-limit'),
    );
    expect(seatCall).toBeDefined();
    expect(seatCall![1]).toMatchObject({ tier: 'pro' });
  });
});

// syncEntitlements — reporting retention leg (Phase 8)

describe('syncEntitlements reporting retention leg', () => {
  beforeEach(() => jest.clearAllMocks());

  /** The PUT call for the reporting retention-sync leg (or undefined). */
  const retentionCall = () =>
    mockClientPut.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/api/reports/retention-sync/'),
    );

  it('pushes the tier-baseline retention (30/180) to reporting with the org path + service auth headers', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(true);
    const call = retentionCall();
    expect(call).toBeDefined();
    // Path carries the root orgId (mirrors platform's seat-limit route shape).
    expect(call![0]).toBe('/api/reports/retention-sync/org-1');
    // Body carries the EFFECTIVE event/dora retention days.
    expect(call![1]).toEqual({ eventRetentionDays: 30, doraRetentionDays: 180 });
    // Same auth mechanism as the seat leg: threaded bearer + x-org-id.
    expect(call![2]).toMatchObject({
      headers: { 'Authorization': 'Bearer tok', 'x-org-id': 'org-1' },
    });
  });

  it('sums bundle grants onto the baseline (base 180 + dora_history_pack ⇒ 545)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1', [
      { bundleId: 'dora_history_pack', quantity: 1 },
    ]);

    const call = retentionCall();
    expect(call).toBeDefined();
    expect(call![1]).toEqual({ eventRetentionDays: 30, doraRetentionDays: 180 + 365 });
  });

  it('stacks retention_pack event grants (base 30 + 2× retention_pack ⇒ 210)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1', [
      { bundleId: 'retention_pack', quantity: 2 },
    ]);

    const call = retentionCall();
    expect(call![1]).toEqual({ eventRetentionDays: 30 + 180, doraRetentionDays: 180 });
  });

  it('passes -1 (unlimited) through untouched for the unlimited tier', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    // A -1 base is never added onto — even with a retention bundle it stays -1.
    await syncEntitlements('org-1', 'unlimited' as any, 'Bearer tok', 'sub-1', [
      { bundleId: 'dora_history_pack', quantity: 1 },
    ]);

    const call = retentionCall();
    expect(call![1]).toEqual({ eventRetentionDays: -1, doraRetentionDays: -1 });
  });

  it('D7: clamps a summed retention above 730 down to the ceiling (defensive)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    // base 30 + 8× retention_pack(90) = 750 > 730 → clamped to 730 by the sync leg
    // (the purchase route's maxQuantity already bounds this; the clamp is defense).
    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1', [
      { bundleId: 'retention_pack', quantity: 8 },
    ]);

    const call = retentionCall();
    expect(call![1]).toEqual({ eventRetentionDays: 730, doraRetentionDays: 180 });
  });

  it('sets the entitlementSyncPending marker when ONLY the reporting leg fails', async () => {
    // Quota + platform legs succeed; the reporting leg 5xx's. The shared pending
    // marker must still be set so the lifecycle reconciler re-drives the sync.
    mockClientPut.mockImplementation((...args: unknown[]) => {
      const path = args[0] as string;
      if (path.includes('/api/reports/retention-sync/')) return Promise.resolve({ statusCode: 500 });
      return Promise.resolve({ statusCode: 200 });
    });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    expect(mockSubscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sub-1' },
      { $set: { 'metadata.entitlementSyncPending': true } },
    );
  });

  it('never fails the sync when the reporting leg THROWS (fail-open, marker set)', async () => {
    mockClientPut.mockImplementation((...args: unknown[]) => {
      const path = args[0] as string;
      if (path.includes('/api/reports/retention-sync/')) return Promise.reject(new Error('reporting down'));
      return Promise.resolve({ statusCode: 200 });
    });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    expect(mockSubscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sub-1' },
      { $set: { 'metadata.entitlementSyncPending': true } },
    );
  });
});

// syncEntitlements — compliance content-set leg (compliance add-ons)

describe('syncEntitlements compliance content-set leg', () => {
  beforeEach(() => jest.clearAllMocks());

  /** The PUT call for the compliance entitlements leg (or undefined). */
  const complianceCall = () =>
    mockClientPut.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/api/compliance/entitlements/'),
    );

  it('pushes an EMPTY set for a plain tier with no compliance entitlement', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(true);
    const call = complianceCall();
    expect(call).toBeDefined();
    // Path carries the root orgId (mirrors reporting's retention-sync shape).
    expect(call![0]).toBe('/api/compliance/entitlements/org-1');
    // Body carries the derived sets PLUS the entitlement-change `occurredAt`
    // (handshake #1) — an ISO string the compliance watermark orders pushes by.
    expect(call![1]).toMatchObject({ sets: [] });
    const body = call![1] as { occurredAt?: unknown };
    expect(typeof body.occurredAt).toBe('string');
    expect(new Date(body.occurredAt as string).toISOString()).toBe(body.occurredAt);
    // Same auth mechanism as the retention/seat legs: threaded bearer + x-org-id.
    expect(call![2]).toMatchObject({
      headers: { 'Authorization': 'Bearer tok', 'x-org-id': 'org-1' },
    });
  });

  it('derives ["standard"] from the compliance_standard bundle', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1', [
      { bundleId: 'compliance_standard', quantity: 1 },
    ]);

    expect(complianceCall()![1]).toMatchObject({ sets: ['standard'] });
  });

  it('derives ["standard","advanced"] when both compliance bundles are held', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1', [
      { bundleId: 'compliance_standard', quantity: 1 },
      { bundleId: 'compliance_advanced', quantity: 1 },
    ]);

    expect(complianceCall()![1]).toMatchObject({ sets: ['standard', 'advanced'] });
  });

  it('derives BOTH sets from an Enterprise tier (auto-included features, no bundles)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    await syncEntitlements('org-1', 'enterprise' as any, 'Bearer tok', 'sub-1');

    expect(complianceCall()![1]).toMatchObject({ sets: ['standard', 'advanced'] });
  });

  it('derives BOTH sets from the Unlimited tier (billing-disabled default)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    await syncEntitlements('org-1', 'unlimited' as any, 'Bearer tok', 'sub-1');

    expect(complianceCall()![1]).toMatchObject({ sets: ['standard', 'advanced'] });
  });

  it('sets the entitlementSyncPending marker when ONLY the compliance leg fails', async () => {
    // Quota + platform + reporting succeed; the compliance leg 5xx's. The shared
    // pending marker must still be set so the reconciler re-drives the sync.
    mockClientPut.mockImplementation((...args: unknown[]) => {
      const path = args[0] as string;
      if (path.includes('/api/compliance/entitlements/')) return Promise.resolve({ statusCode: 500 });
      return Promise.resolve({ statusCode: 200 });
    });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    expect(mockSubscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sub-1' },
      { $set: { 'metadata.entitlementSyncPending': true } },
    );
  });

  it('never fails the sync when the compliance leg THROWS (fail-open, marker set)', async () => {
    mockClientPut.mockImplementation((...args: unknown[]) => {
      const path = args[0] as string;
      if (path.includes('/api/compliance/entitlements/')) return Promise.reject(new Error('compliance down'));
      return Promise.resolve({ statusCode: 200 });
    });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    expect(mockSubscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sub-1' },
      { $set: { 'metadata.entitlementSyncPending': true } },
    );
  });
});
