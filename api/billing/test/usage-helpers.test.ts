// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for cost / usage rollup helper.
 *
 * The pure `buildUsageRollup` is what the dashboard ultimately sees, so the
 * tests exercise it directly  no network mocking. The HTTP variant is a
 * thin wrapper around `fetchQuotaSnapshot` + `buildUsageRollup`; its happy
 * path is covered indirectly by the snapshot mock here.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// A single controllable client.get so buildUsageRollupFor tests can drive
// both the quota-snapshot and platform seat-usage round-trips by URL.
const clientGet = jest.fn<(path: string, opts?: unknown) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({ get: clientGet }),
  getServiceAuthHeader: () => 'Bearer test-service',
  // api-server's app-factory wires this at module load.
  setCounterEmitter: jest.fn(),
}));

// Stub api-server so its idempotency-middleware + app-factory don't try to
// initialize a real Prometheus registry at module load.
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', async () => {
  // billing-helpers imports effectiveEntitlements from pipeline-core; even though
  // usage-helpers doesn't call it, ESM linking requires the export to exist.
  const { effectiveEntitlements } = await import(
    '@pipeline-builder/pipeline-core/lib/config/entitlements.js'
  );
  return {
    Config: {
      getAny: () => ({ services: { billingTimeout: 5000 } }),
      // getBillingTimeout() reads Config.get('server').
      get: () => ({ services: { billingTimeout: 5000 } }),
    },
    effectiveEntitlements,
    // usage-helpers transitively imports api-server (via billing-helpers),
    // whose idempotency-middleware reads these at module load.
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

const { buildUsageRollup, buildUsageRollupFor } = await import('../src/helpers/usage-helpers.js');

describe('buildUsageRollup', () => {
  const now = new Date('2026-05-15T00:00:00Z');

  it('returns a default 30-day window when there is no subscription', () => {
    const rollup = buildUsageRollup(null, null, null, now);

    expect(rollup.subscription).toBeNull();
    expect(rollup.cost).toEqual({ subscriptionCents: 0, currency: 'USD' });
    expect(rollup.usage).toEqual({});
    // Seats default to null when not supplied (pure helper takes no network).
    expect(rollup.seats).toBeNull();

    const periodMs = new Date(rollup.period.end).getTime() - new Date(rollup.period.start).getTime();
    // ~60 days wide: 30 before now + 30 after.
    expect(Math.round(periodMs / 86_400_000)).toBe(60);
  });

  it('derives period + cost from the active subscription', () => {
    const rollup = buildUsageRollup( {
      currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      interval: 'monthly',
      planId: 'plan-pro',
    },
    { name: 'Pro', tier: 'pro', prices: { monthly: 4900, annual: 49000 } },
    null,
    now,
    );

    expect(rollup.subscription).toEqual({
      planId: 'plan-pro',
      planName: 'Pro',
      tier: 'pro',
      interval: 'monthly',
      priceCents: 4900,
    });
    expect(rollup.period.daysElapsed).toBe(14);
    expect(rollup.period.daysRemaining).toBe(17);
    expect(rollup.cost.subscriptionCents).toBe(4900);
  });

  it('picks the annual price when the subscription interval is annual', () => {
    const rollup = buildUsageRollup( {
      currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
      currentPeriodEnd: new Date('2027-01-01T00:00:00Z'),
      interval: 'annual',
      planId: 'plan-pro',
    },
    { name: 'Pro', tier: 'pro', prices: { monthly: 4900, annual: 49000 } },
    null,
    now,
    );

    expect(rollup.subscription?.priceCents).toBe(49000);
    expect(rollup.cost.subscriptionCents).toBe(49000);
  });

  it('computes percent/remaining for capped quotas and nulls them for unlimited', () => {
    const rollup = buildUsageRollup( null,
      null,
      {
        tier: 'developer',
        quotas: { plugins: 100, pipelines: 10, apiCalls: -1, aiCalls: 100, storageBytes: 5368709120 },
        usage: {
          plugins: { used: 25, resetAt: '2026-06-01T00:00:00Z' },
          pipelines: { used: 10, resetAt: '2026-06-01T00:00:00Z' },
          apiCalls: { used: 12345, resetAt: '2026-06-01T00:00:00Z' },
          aiCalls: { used: 0, resetAt: '2026-06-01T00:00:00Z' },
          storageBytes: { used: 1073741824, resetAt: '2026-06-01T00:00:00Z' },
        },
      },
      now,
    );

    expect(rollup.usage.plugins).toEqual({
      used: 25, limit: 100, remaining: 75, percentOfLimit: 25, resetAt: '2026-06-01T00:00:00Z',
    });
    // pipelines is at 100%  clamp keeps us at exactly 100, remaining 0.
    expect(rollup.usage.pipelines.percentOfLimit).toBe(100);
    expect(rollup.usage.pipelines.remaining).toBe(0);
    // apiCalls is unlimited (limit = -1)  percent + remaining must be null
    // so the UI knows to render an em-dash instead of a misleading bar.
    expect(rollup.usage.apiCalls.percentOfLimit).toBeNull();
    expect(rollup.usage.apiCalls.remaining).toBeNull();
    // Storage uses the same shape; 1 GB of 5 GB is 20%.
    expect(rollup.usage.storageBytes.percentOfLimit).toBe(20);
  });

  it('handles a missing usage row by reporting 0 used (defensive vs older quota docs)', () => {
    const rollup = buildUsageRollup( null,
      null,
      {
        tier: 'developer',
        quotas: { plugins: 100, pipelines: 10, apiCalls: -1, aiCalls: 100, storageBytes: -1 },
        // usage map missing pipelines
        usage: {
          plugins: { used: 5, resetAt: '2026-06-01T00:00:00Z' },
        },
      } as any,
      now,
    );

    expect(rollup.usage.pipelines.used).toBe(0);
    expect(rollup.usage.pipelines.limit).toBe(10);
    expect(rollup.usage.pipelines.percentOfLimit).toBe(0);
  });

  it('clamps daysElapsed/daysRemaining at zero when now is outside the period', () => {
    const future = new Date('2026-07-01T00:00:00Z');
    const rollup = buildUsageRollup( {
      currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      interval: 'monthly',
      planId: 'plan-pro',
    },
    { name: 'Pro', tier: 'pro', prices: { monthly: 4900, annual: 49000 } },
    null,
    future,
    );

    expect(rollup.period.daysRemaining).toBe(0);
    expect(rollup.period.daysElapsed).toBeGreaterThan(0);
  });

  it('surfaces a seats block when seat usage is supplied', () => {
    const rollup = buildUsageRollup(null, null, null, now, { limit: 10, used: 7 });
    expect(rollup.seats).toEqual({ limit: 10, used: 7 });
  });
});

/**
 * The HTTP wrapper joins the quota-snapshot fetch with the platform
 * seat-usage fetch. Both are driven through the shared `clientGet` mock,
 * keyed by request path.
 */
describe('buildUsageRollupFor', () => {
  const SNAPSHOT_BODY = {
    success: true,
    data: {
      quota: {
        tier: 'team',
        quotas: { plugins: 100, pipelines: 10 },
        usage: {
          plugins: { used: 25, resetAt: '2026-06-01T00:00:00Z' },
          pipelines: { used: 3, resetAt: '2026-06-01T00:00:00Z' },
        },
      },
    },
  };

  beforeEach(() => {
    clientGet.mockReset();
  });

  it('enriches the rollup with seats sourced from the platform seat-usage call', async () => {
    clientGet.mockImplementation((path: string) => {
      if (path.includes('/seat-usage')) {
        return { statusCode: 200, body: { success: true, data: { limit: 25, used: 12 } } };
      }
      return { statusCode: 200, body: SNAPSHOT_BODY };
    });

    const rollup = await buildUsageRollupFor('org-1', 'Bearer user', null, null);

    // The seat-usage endpoint was hit on platform.
    expect(clientGet.mock.calls.some(([p]) => String(p).includes('/organization/org-1/seat-usage'))).toBe(true);
    expect(rollup.seats).toEqual({ limit: 25, used: 12 });
    // Quota types still present alongside the seats enrichment.
    expect(Object.keys(rollup.usage).sort()).toEqual(['pipelines', 'plugins']);
  });

  it('degrades gracefully to null seats when the platform seat-usage call fails', async () => {
    clientGet.mockImplementation((path: string) => {
      if (path.includes('/seat-usage')) {
        return { statusCode: 502, body: { success: false } };
      }
      return { statusCode: 200, body: SNAPSHOT_BODY };
    });

    const rollup = await buildUsageRollupFor('org-1', 'Bearer user', null, null);

    // Seats omitted (null), but the quota-type rollup still returns intact.
    expect(rollup.seats).toBeNull();
    expect(rollup.usage.plugins).toMatchObject({ used: 25, limit: 100 });
    expect(rollup.usage.pipelines).toMatchObject({ used: 3, limit: 10 });
  });

  it('degrades gracefully when the platform call throws', async () => {
    clientGet.mockImplementation((path: string) => {
      if (path.includes('/seat-usage')) throw new Error('connection refused');
      return { statusCode: 200, body: SNAPSHOT_BODY };
    });

    const rollup = await buildUsageRollupFor('org-1', 'Bearer user', null, null);

    expect(rollup.seats).toBeNull();
    expect(Object.keys(rollup.usage)).toContain('plugins');
  });
});
