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
});
