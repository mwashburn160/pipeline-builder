// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for billing helper functions.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockBillingEventCreate = jest.fn<AnyFn>();

jest.unstable_mockModule('../src/models/billing-event.js', () => ({
  BillingEvent: {
    create: mockBillingEventCreate,
  },
}));

// entitlement-sync imports the Subscription model; stub it so no real Mongo is
// touched (a failed sync publishes a durable-bus retry, not a row marker).
const mockSubscriptionUpdateOne = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ modifiedCount: 1 });
// findById backs (a) syncEntitlements' occurredAt read (`.select().lean()`) and
// (b) the retry consumer's re-read of the CURRENT row (awaited directly).
const mockSubscriptionRow = jest.fn<(...args: unknown[]) => unknown>().mockReturnValue(null);
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    updateOne: (...args: unknown[]) => mockSubscriptionUpdateOne(...args),
    findById: (...args: unknown[]) => {
      const p = Promise.resolve(mockSubscriptionRow(...args));
      return Object.assign(p, { select: () => ({ lean: () => p }) });
    },
  },
}));
const mockPlanFindById = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ tier: 'pro' });
jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: { findById: (...args: unknown[]) => mockPlanFindById(...args) },
}));

// Stub the provider factory so no real Stripe/AWS SDK is loaded.
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({ syncAddons: jest.fn<AnyFn>() }),
}));

const mockClientPut = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({
    put: mockClientPut,
  }),
  // api-server's app-factory wires this at module load to inject the metrics
  // counter into api-core helpers; tests just need it to be callable.
  setCounterEmitter: jest.fn<AnyFn>(),
  getServiceAuthHeader: jest.fn(() => 'Bearer test-service'),
}));

// Stub api-server so its idempotency-middleware + app-factory don't try to
// initialize a real Prometheus registry at module load.
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: jest.fn<AnyFn>(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: (section: string) => (section === 'server' ? { services: { billingTimeoutMs: 5000 } } : {}) },
  // api-server's idempotency-middleware reads these at module load.
  CoreConstants: {
    IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000,
    IDEMPOTENCY_TTL_MS: 300_000,
    IDEMPOTENCY_MAX_STORE_SIZE: 10_000,
  },
}));

// Retention bundles — the retention leg sums these grants onto the tier baseline.
// `dora_history_pack` grants +365 dora days (base 180 → 545); `retention_pack`
// grants +90 event days. The compliance bundles are pure-feature (no quota
// grants); the compliance sync leg derives its `sets` from these granted flags.
jest.unstable_mockModule('../src/config/billing-config.js', () => ({
  getBillingConfig: () => ({
    plans: [],
    comboDiscounts: [],
    bundles: [
      { id: 'retention_pack', name: 'Retention Pack', description: '', grants: { eventRetentionDays: 90 }, prices: { monthly: 1500, annual: 15000 }, stackable: true, availableForTiers: ['developer', 'pro', 'team', 'enterprise'], isActive: true, sortOrder: 10 },
      { id: 'dora_history_pack', name: 'DORA History Pack', description: '', grants: { doraRetentionDays: 365 }, prices: { monthly: 3000, annual: 30000 }, stackable: true, availableForTiers: ['developer', 'pro', 'team', 'enterprise'], isActive: true, sortOrder: 11 },
      { id: 'compliance_standard', name: 'Standard Compliance', description: '', grants: {}, features: ['compliance_standard'], prices: { monthly: 2990, annual: 29900 }, stackable: false, availableForTiers: ['developer', 'pro', 'team'], isActive: true, sortOrder: 12 },
      { id: 'compliance_advanced', name: 'Advanced Compliance', description: '', grants: {}, features: ['compliance_advanced'], prices: { monthly: 9990, annual: 99900 }, stackable: false, availableForTiers: ['developer', 'pro', 'team'], requires: ['compliance_standard'], isActive: true, sortOrder: 13 },
    ],
  }),
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quotaService: { host: 'quota', port: 3000 },
    platformService: { host: 'platform', port: 3000 },
    reportingService: { host: 'reporting', port: 3000 },
    complianceService: { host: 'compliance', port: 3000 },
    paymentGracePeriodDays: 7,
  },
}));

const { calculatePeriodEnd, createBillingEvent, renewedPeriod } = await import('../src/helpers/billing-helpers.js');
const { buildSubscriptionResponse } = await import('../src/helpers/subscription-response.js');
const {
  syncTierToQuotaService,
  syncEntitlements,
  setEntitlementSyncBus,
  startEntitlementSyncConsumer,
  entitlementSyncConsumerName,
} = await import('../src/helpers/entitlement-sync.js');
const { effectiveEntitlements } = await import('../src/config/entitlements.js');

// effectiveEntitlements — bundle math

describe('effectiveEntitlements', () => {
  const bundles = [
    { id: 'seat_pack', name: 'Seat Pack', description: '', grants: { seats: 5 }, prices: { monthly: 2500, annual: 25000 }, stackable: true, availableForTiers: ['pro'], isActive: true, sortOrder: 0 },
    { id: 'pipeline_pack', name: 'Pipeline Pack', description: '', grants: { pipelines: 10 }, prices: { monthly: 1500, annual: 15000 }, stackable: true, availableForTiers: ['pro'], isActive: true, sortOrder: 1 },
    { id: 'bulk_operations', name: 'Bulk Operations', description: '', grants: {}, features: ['bulk_operations'], prices: { monthly: 2000, annual: 20000 }, stackable: false, availableForTiers: ['pro'], isActive: true, sortOrder: 2 },
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
      { bundleId: 'bulk_operations', quantity: 1 },
      { bundleId: 'nope', quantity: 5 },
    ], bundles);
    expect(features).toContain('bulk_operations');
    expect(limits.seats).toBe(10); // unchanged
  });
});

// calculatePeriodEnd

describe('calculatePeriodEnd', () => {
  const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it('leaves a mid-month monthly period unchanged', () => {
    expect(calculatePeriodEnd(utc('2026-03-15'), 'monthly', 15)).toEqual(utc('2026-04-15'));
  });

  it('adds one year for an annual period', () => {
    expect(calculatePeriodEnd(utc('2026-03-15'), 'annual', 15)).toEqual(utc('2027-03-15'));
  });

  it('clamps Jan 31 to the last day of February instead of overflowing into March', () => {
    expect(calculatePeriodEnd(utc('2026-01-31'), 'monthly', 31)).toEqual(utc('2026-02-28'));
    expect(calculatePeriodEnd(utc('2028-01-31'), 'monthly', 31)).toEqual(utc('2028-02-29'));
  });

  it('clamps Mar 31 to Apr 30', () => {
    expect(calculatePeriodEnd(utc('2026-03-31'), 'monthly', 31)).toEqual(utc('2026-04-30'));
  });

  it('ends a Feb 29 annual period on Feb 28 of the following year', () => {
    expect(calculatePeriodEnd(utc('2028-02-29'), 'annual', 29)).toEqual(utc('2029-02-28'));
  });

  it('keeps the anchor across a chained monthly run from Jan 31', () => {
    const ends: Date[] = [];
    let start = utc('2026-01-31');
    for (let i = 0; i < 3; i++) {
      start = calculatePeriodEnd(start, 'monthly', 31);
      ends.push(start);
    }
    expect(ends).toEqual([utc('2026-02-28'), utc('2026-03-31'), utc('2026-04-30')]);
  });

  it('works in UTC and keeps the UTC time of day', () => {
    const start = new Date('2026-01-31T23:30:15.250Z');
    expect(calculatePeriodEnd(start, 'monthly', 31)).toEqual(new Date('2026-02-28T23:30:15.250Z'));
  });

  it('crosses a year boundary', () => {
    expect(calculatePeriodEnd(utc('2026-12-31'), 'monthly', 31)).toEqual(utc('2027-01-31'));
  });

  it('rejects an anchor outside 1-31', () => {
    expect(() => calculatePeriodEnd(utc('2026-03-15'), 'monthly', 0)).toThrow(RangeError);
    expect(() => calculatePeriodEnd(utc('2026-03-15'), 'monthly', 32)).toThrow(RangeError);
    expect(() => calculatePeriodEnd(utc('2026-03-15'), 'monthly', 1.5)).toThrow(RangeError);
  });

  it('does not mutate the input date', () => {
    const start = utc('2026-06-15');
    calculatePeriodEnd(start, 'monthly', 15);
    expect(start).toEqual(utc('2026-06-15'));
  });
});

// renewedPeriod

describe('renewedPeriod', () => {
  const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it('starts the next period at the old end and ends it on the anchor day', () => {
    expect(renewedPeriod({
      currentPeriodStart: utc('2026-01-31'), currentPeriodEnd: utc('2026-02-28'), interval: 'monthly', billingAnchorDay: 31,
    }, utc('2026-03-01'))).toEqual({ start: utc('2026-02-28'), end: utc('2026-03-31') });
  });

  it('skips every renewal missed while it was stale, keeping the anchor day', () => {
    expect(renewedPeriod({
      currentPeriodStart: utc('2026-01-31'), currentPeriodEnd: utc('2026-02-28'), interval: 'monthly', billingAnchorDay: 31,
    }, utc('2026-05-10'))).toEqual({ start: utc('2026-04-30'), end: utc('2026-05-31') });
  });

  it("uses the period's start day when no anchor is stored", () => {
    expect(renewedPeriod({
      currentPeriodStart: utc('2026-03-15'), currentPeriodEnd: utc('2026-04-15'), interval: 'annual',
    }, utc('2026-04-16'))).toEqual({ start: utc('2026-04-15'), end: utc('2027-04-15') });
  });

  it('a period ending exactly now is over', () => {
    expect(renewedPeriod({
      currentPeriodStart: utc('2026-03-01'), currentPeriodEnd: utc('2026-04-01'), interval: 'monthly', billingAnchorDay: 1,
    }, utc('2026-05-01')).start).toEqual(utc('2026-05-01'));
  });
});

// createBillingEvent

describe('createBillingEvent', () => {
  beforeEach(() => { jest.clearAllMocks(); });

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

  it('reports no dunning outside a lapse', () => {
    expect(buildSubscriptionResponse(baseSub).dunning).toBeNull();
    // A stale firstFailedAt on an active row is not a lapse.
    expect(buildSubscriptionResponse({ ...baseSub, firstFailedAt: new Date('2026-03-02') }).dunning).toBeNull();
  });

  it('gives a past_due row its grace DEADLINE (firstFailedAt + grace days)', () => {
    const result = buildSubscriptionResponse({ ...baseSub, status: 'past_due', firstFailedAt: new Date('2026-03-10T00:00:00Z'), metadata: {} });
    expect(result.dunning).toEqual({
      firstFailedAt: '2026-03-10T00:00:00.000Z',
      downgradeAt: '2026-03-17T00:00:00.000Z',
      downgraded: false,
    });
  });

  it('says the downgrade ALREADY happened once the grace cron ran (status stays past_due)', () => {
    const result = buildSubscriptionResponse({
      ...baseSub,
      status: 'past_due',
      firstFailedAt: new Date('2026-03-10T00:00:00Z'),
      metadata: { gracePeriodDowngradedAt: '2026-03-17T01:00:00.000Z' },
    });
    expect(result.dunning).toEqual(expect.objectContaining({ downgraded: true, downgradedAt: '2026-03-17T01:00:00.000Z' }));
  });
});

// syncTierToQuotaService

describe('syncTierToQuotaService', () => {
  beforeEach(() => { jest.clearAllMocks(); });

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
  // Quota's staff route (PUT /quotas/:orgId) requires the system org + MFA and
  // refuses billing's per-org service token, so the sync must use the internal
  // billing-only route.
  it('pushes to quota\'s internal entitlement-sync route, not the staff route', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });
    await syncTierToQuotaService('org-1', 'pro' as any, 'Bearer tok');
    expect(mockClientPut.mock.calls[0][0]).toBe('/quotas/entitlement-sync/org-1');
  });
});

// syncEntitlements — durable event-bus retry on failure

describe('syncEntitlements durable-bus retry', () => {
  const mockPublish = jest.fn<(topic: string, payload: unknown) => Promise<string | null>>();
  beforeEach(() => {
    jest.clearAllMocks();
    mockPublish.mockResolvedValue('1-0');
    // A failed sync publishes a retry event to the durable bus (replaces the old
    // entitlementSyncPending marker + polling reconciler).
    setEntitlementSyncBus({ publish: mockPublish, subscribe: jest.fn<AnyFn>() } as never);
  });
  afterEach(() => setEntitlementSyncBus(null));

  it('publishes NO retry when all legs succeed', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(true);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes a retry event when a leg fails (fail-open, still returns false)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 500 });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1', [{ bundleId: 'b1', quantity: 2 }]);

    expect(ok).toBe(false);
    expect(mockPublish).toHaveBeenCalledWith('entitlement.sync', {
      orgId: 'org-1',
      tier: 'pro',
      subscriptionId: 'sub-1',
      addons: [{ bundleId: 'b1', quantity: 2 }],
      occurredAt: expect.any(String),
    });
  });

  it('a retry carries the ROW\'s change time (updatedAt), which is what every leg receives', async () => {
    const updatedAt = new Date('2026-09-01T12:00:00.000Z');
    mockSubscriptionRow.mockReturnValue({ _id: 'sub-1', status: 'active', planId: 'pro-plan', addons: [], metadata: {}, updatedAt });
    mockClientPut.mockResolvedValue({ statusCode: 500 });
    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');
    // Every leg (not just compliance) carries the same moment.
    for (const call of mockClientPut.mock.calls) {
      expect((call[1] as { occurredAt?: string }).occurredAt).toBe(updatedAt.toISOString());
    }
    const { occurredAt } = mockPublish.mock.calls[0][1] as { occurredAt: string };
    const complianceBody = (call: unknown[]) => call[1] as { occurredAt?: string };
    const inline = mockClientPut.mock.calls.find((c) => String(c[0]).includes('/compliance/entitlements/'));
    // The inline attempt and the queued retry share one timestamp …
    expect(complianceBody(inline!).occurredAt).toBe(occurredAt);

    // … and the consumer replays it rather than stamping "now".
    let handler: ((env: { payload: unknown }) => Promise<void>) | undefined;
    startEntitlementSyncConsumer({ subscribe: (o: { handler: typeof handler }) => { handler = o.handler; return { stop: async () => {} }; } } as never);
    mockClientPut.mockClear();
    mockClientPut.mockResolvedValue({ statusCode: 200 });
    await handler!({ payload: mockPublish.mock.calls[0][1] });
    const replay = mockClientPut.mock.calls.find((c) => String(c[0]).includes('/compliance/entitlements/'));
    expect(complianceBody(replay!).occurredAt).toBe(occurredAt);
    mockSubscriptionRow.mockReturnValue(null);
  });

  describe('retry consumer identity', () => {
    const savedHost = process.env.HOSTNAME;
    afterEach(() => {
      if (savedHost === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = savedHost;
    });

    it('subscribes with a per-container consumer id, not `billing-<pid>` (PID 1 in every container)', () => {
      process.env.HOSTNAME = 'billing-7d9f-abcde';
      let consumer: string | undefined;
      startEntitlementSyncConsumer({ subscribe: (o: { consumer: string }) => { consumer = o.consumer; return { stop: async () => {} }; } } as never);
      expect(consumer).toMatch(new RegExp(`^billing-billing-7d9f-abcde-${process.pid}-[0-9a-f]{6}$`));
    });

    it('is unique per process even when two replicas share a hostname', () => {
      process.env.HOSTNAME = 'same-host';
      expect(entitlementSyncConsumerName()).not.toBe(entitlementSyncConsumerName());
    });

    it('falls back to os.hostname() when HOSTNAME is unset', () => {
      delete process.env.HOSTNAME;
      expect(entitlementSyncConsumerName()).toMatch(/^billing-.+-\d+-[0-9a-f]{6}$/);
    });
  });

  describe('retry consumer re-reads the CURRENT subscription (never replays a stale payload)', () => {
    let handler: ((env: { payload: unknown }) => Promise<void>) | undefined;
    beforeEach(() => {
      startEntitlementSyncConsumer({ subscribe: (o: { handler: typeof handler }) => { handler = o.handler; return { stop: async () => {} }; } } as never);
      mockClientPut.mockResolvedValue({ statusCode: 200 });
    });
    afterEach(() => { mockSubscriptionRow.mockReturnValue(null); });
    const quotaBody = () => mockClientPut.mock.calls.find((c) => String(c[0]).startsWith('/quotas/'))?.[1] as { tier?: string } | undefined;
    const stalePayload = { orgId: 'org-1', tier: 'enterprise', subscriptionId: 'sub-1', addons: [{ bundleId: 'b1', quantity: 2 }], occurredAt: '2026-01-01T00:00:00.000Z' };

    it('a sub canceled since the failure is pushed at the developer baseline, not the queued paid tier', async () => {
      mockSubscriptionRow.mockReturnValue({ _id: 'sub-1', status: 'canceled', planId: 'ent', addons: [{ bundleId: 'b1', quantity: 2 }], metadata: {}, updatedAt: new Date('2026-09-02T00:00:00Z') });
      await handler!({ payload: stalePayload });
      expect(quotaBody()?.tier).toBe('developer');
      expect(mockPlanFindById).not.toHaveBeenCalled();
    });

    it('a plan change since the failure is pushed from the CURRENT plan', async () => {
      mockSubscriptionRow.mockReturnValue({ _id: 'sub-1', status: 'active', planId: 'team-plan', addons: [], metadata: {}, updatedAt: new Date('2026-09-02T00:00:00Z') });
      mockPlanFindById.mockResolvedValueOnce({ tier: 'team' });
      await handler!({ payload: stalePayload });
      expect(mockPlanFindById).toHaveBeenCalledWith('team-plan');
      expect(quotaBody()?.tier).toBe('team');
    });

    it('a grace-downgraded past_due row is pushed at developer', async () => {
      mockSubscriptionRow.mockReturnValue({ _id: 'sub-1', status: 'past_due', planId: 'ent', addons: [], metadata: { gracePeriodDowngradedAt: 'x' }, updatedAt: new Date() });
      await handler!({ payload: stalePayload });
      expect(quotaBody()?.tier).toBe('developer');
    });

    it('drops (acks) the retry when the subscription row is gone', async () => {
      mockSubscriptionRow.mockReturnValue(null);
      await expect(handler!({ payload: stalePayload })).resolves.toBeUndefined();
      expect(mockClientPut).not.toHaveBeenCalled();
    });
  });

  it('never throws even if the bus publish rejects (preserves fail-open contract)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 500 });
    mockPublish.mockRejectedValueOnce(new Error('redis down'));

    await expect(syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1')).resolves.toBe(false);
  });

  it('runs inline with NO retry publish when no bus is registered', async () => {
    setEntitlementSyncBus(null);
    mockClientPut.mockResolvedValue({ statusCode: 500 });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    expect(mockPublish).not.toHaveBeenCalled();
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

// syncEntitlements — reporting retention leg

describe('syncEntitlements reporting retention leg', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  /** The PUT call for the reporting retention-sync leg (or undefined). */
  const retentionCall = () =>
    mockClientPut.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/reports/retention-sync/'),
    );

  it('pushes the tier-baseline retention (30/180) to reporting with the org path + service auth headers', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(true);
    const call = retentionCall();
    expect(call).toBeDefined();
    // Path carries the root orgId (mirrors platform's seat-limit route shape).
    expect(call![0]).toBe('/reports/retention-sync/org-1');
    // Body carries the EFFECTIVE event/dora retention days.
    expect(call![1]).toEqual({ eventRetentionDays: 30, doraRetentionDays: 180, occurredAt: expect.any(String) });
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
    expect(call![1]).toEqual({ eventRetentionDays: 30, doraRetentionDays: 180 + 365, occurredAt: expect.any(String) });
  });

  it('stacks retention_pack event grants (base 30 + 2× retention_pack ⇒ 210)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1', [
      { bundleId: 'retention_pack', quantity: 2 },
    ]);

    const call = retentionCall();
    expect(call![1]).toEqual({ eventRetentionDays: 30 + 180, doraRetentionDays: 180, occurredAt: expect.any(String) });
  });

  it('passes -1 (unlimited) through untouched for the unlimited tier', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    // A -1 base is never added onto — even with a retention bundle it stays -1.
    await syncEntitlements('org-1', 'unlimited' as any, 'Bearer tok', 'sub-1', [
      { bundleId: 'dora_history_pack', quantity: 1 },
    ]);

    const call = retentionCall();
    expect(call![1]).toEqual({ eventRetentionDays: -1, doraRetentionDays: -1, occurredAt: expect.any(String) });
  });

  it('clamps a summed retention above 730 down to the ceiling (defensive)', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    // base 30 + 8× retention_pack(90) = 750 > 730 → clamped to 730 by the sync leg
    // (the purchase route's maxQuantity already bounds this; the clamp is defense).
    await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1', [
      { bundleId: 'retention_pack', quantity: 8 },
    ]);

    const call = retentionCall();
    expect(call![1]).toEqual({ eventRetentionDays: 730, doraRetentionDays: 180, occurredAt: expect.any(String) });
  });

  it('returns false (fail-open) when ONLY the reporting leg fails', async () => {
    // Quota + platform legs succeed; the reporting leg 5xx's. The sync fails open
    // (returns false) and the durable-bus retry is covered in the bus-retry suite.
    mockClientPut.mockImplementation((...args: unknown[]) => {
      const path = args[0] as string;
      if (path.includes('/reports/retention-sync/')) return Promise.resolve({ statusCode: 500 });
      return Promise.resolve({ statusCode: 200 });
    });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    // Fail-open: the sync returns false; the durable-bus retry (published on
    // failure) is covered in the bus-retry suite. No pending marker is written now.
  });

  it('never fails the sync when the reporting leg THROWS (fail-open)', async () => {
    mockClientPut.mockImplementation((...args: unknown[]) => {
      const path = args[0] as string;
      if (path.includes('/reports/retention-sync/')) return Promise.reject(new Error('reporting down'));
      return Promise.resolve({ statusCode: 200 });
    });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    // Fail-open: the sync returns false; the durable-bus retry (published on
    // failure) is covered in the bus-retry suite. No pending marker is written now.
  });
});

// syncEntitlements — compliance content-set leg (compliance add-ons)

describe('syncEntitlements compliance content-set leg', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  /** The PUT call for the compliance entitlements leg (or undefined). */
  const complianceCall = () =>
    mockClientPut.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/compliance/entitlements/'),
    );

  it('pushes an EMPTY set for a plain tier with no compliance entitlement', async () => {
    mockClientPut.mockResolvedValue({ statusCode: 200 });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(true);
    const call = complianceCall();
    expect(call).toBeDefined();
    // Path carries the root orgId (mirrors reporting's retention-sync shape).
    expect(call![0]).toBe('/compliance/entitlements/org-1');
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

  it('returns false (fail-open) when ONLY the compliance leg fails', async () => {
    // Quota + platform + reporting succeed; the compliance leg 5xx's. The sync
    // fails open; the durable-bus retry is covered in the bus-retry suite.
    mockClientPut.mockImplementation((...args: unknown[]) => {
      const path = args[0] as string;
      if (path.includes('/compliance/entitlements/')) return Promise.resolve({ statusCode: 500 });
      return Promise.resolve({ statusCode: 200 });
    });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    // Fail-open: the sync returns false; the durable-bus retry (published on
    // failure) is covered in the bus-retry suite. No pending marker is written now.
  });

  it('never fails the sync when the compliance leg THROWS (fail-open)', async () => {
    mockClientPut.mockImplementation((...args: unknown[]) => {
      const path = args[0] as string;
      if (path.includes('/compliance/entitlements/')) return Promise.reject(new Error('compliance down'));
      return Promise.resolve({ statusCode: 200 });
    });

    const ok = await syncEntitlements('org-1', 'pro' as any, 'Bearer tok', 'sub-1');

    expect(ok).toBe(false);
    // Fail-open: the sync returns false; the durable-bus retry (published on
    // failure) is covered in the bus-retry suite. No pending marker is written now.
  });
});
