// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SHORT-LIVED pooled-cap fallback (`QUOTA_POOL_FALLBACK_TTL_MS`).
 *
 * Denying every team the moment a hierarchy read blips would turn a Mongo
 * hiccup into a fleet-wide outage, so a successfully resolved root cap is
 * memoized for a minute and served when a LATER resolution fails. It is only
 * ever read on the failure path — the happy path always re-resolves, so normal
 * enforcement stays exact — and it is stale-low on `used`, which is bounded by
 * the TTL and is still real enforcement, unlike the -1 row it replaces.
 *
 * Companion to pooled-quota.test.ts, which runs with the fallback disabled.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const emitCounter = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  emitCounter,
  isValidTier: () => true,
  ValidationError: class ValidationError extends Error {},
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls', 'storageBytes'],
  QUOTA_TIERS: { developer: { limits: { plugins: 100, pipelines: 10, apiCalls: -1 } } },
  VALID_TIERS: ['developer', 'pro', 'team', 'enterprise'],
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
}));

type Lookup = { self: unknown; parentOrgId?: string; hasChildren: boolean };
const findOrgWithHierarchy = jest.fn<(id: string, fields: string) => Promise<Lookup>>();
const resolveRootOrgId = jest.fn<(id: string) => Promise<string>>();
const expandOrgScope = jest.fn<(id: string) => Promise<string[]>>();
const getParentOrgId = jest.fn<(id: string) => Promise<string | undefined>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  findOrgWithHierarchy,
  resolveRootOrgId,
  expandOrgScope,
  getParentOrgId,
}));

const findOneAndUpdate = jest.fn<AnyFn>();
const findById = jest.fn<AnyFn>();
const find = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { findOneAndUpdate, findById, find },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quota: {
      resetDays: 30,
      poolFallbackTtlMs: 60_000,
      defaults: { pipelines: 10, plugins: 10, apiCalls: 1000, aiCalls: 100 },
    },
  },
}));

const { quotaService } = await import('../src/services/quota-service.js');
const { QuotaPoolUnavailableError, clearPoolStatusCache } = await import('../src/services/pooled-quota.js');

const future = new Date(Date.now() + 86_400_000);

/** root (plugins limit 100, used 60) + teamA (used 30) ⇒ pooled used 90. */
const poolRows = [
  { _id: 'root', name: 'Acme', tier: 'team', quotas: { plugins: 100, pipelines: 20, apiCalls: -1 }, usage: { plugins: { used: 60, resetAt: future }, pipelines: { used: 1, resetAt: future } } },
  { _id: 'teamA', name: 'Team A', tier: 'developer', quotas: { plugins: -1, pipelines: -1, apiCalls: -1 }, usage: { plugins: { used: 30, resetAt: future }, pipelines: { used: 2, resetAt: future } } },
];

function asTeam() {
  findOrgWithHierarchy.mockResolvedValue({ self: poolRows[1], parentOrgId: 'root', hasChildren: false });
  resolveRootOrgId.mockResolvedValue('root');
  expandOrgScope.mockResolvedValue(['root', 'teamA']);
  find.mockReturnValue({ select: () => ({ lean: async () => poolRows }) });
}

const outcomes = () => emitCounter.mock.calls
  .filter((c) => c[0] === 'quota_pool_resolution_failed_total')
  .map((c) => (c[1] as { outcome: string }).outcome);

beforeEach(() => {
  jest.clearAllMocks();
  clearPoolStatusCache();
  findOneAndUpdate.mockResolvedValue({ quotas: { plugins: -1 }, usage: { plugins: { used: 31, resetAt: future } } });
  asTeam();
});

describe('pooled-cap fallback cache', () => {
  it('serves the last-known root cap when resolution fails, and still ENFORCES it', async () => {
    // Warm: one successful resolution memoizes limit 100 / used 90.
    await quotaService.getQuotaStatus('teamA', 'plugins');

    expandOrgScope.mockRejectedValue(new Error('mongo blip'));

    // 90 + 5 <= 100 ⇒ allowed, and the per-org atomic update runs.
    const allowed = await quotaService.incrementUsage('teamA', 'plugins', 5);
    expect(allowed.exceeded).toBe(false);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);

    // 90 + 20 > 100 ⇒ refused on the STALE cap rather than waved through.
    const refused = await quotaService.incrementUsage('teamA', 'plugins', 20);
    expect(refused.exceeded).toBe(true);
    expect(refused.quota).toMatchObject({ limit: 100, used: 90 });
    expect(outcomes()).toEqual(['cached', 'cached']);
  });

  it('a read served from cache reports the pooled numbers, not the team\'s -1 row', async () => {
    await quotaService.findByOrgId('teamA');
    expandOrgScope.mockRejectedValue(new Error('mongo blip'));

    const quota = await quotaService.findByOrgId('teamA');
    expect(quota.quotas.plugins).toMatchObject({ limit: 100, used: 90 });
    expect(outcomes()).toEqual(['cached']);
  });

  it('DENIES once the entry has expired (no cap may be served forever)', async () => {
    await quotaService.getQuotaStatus('teamA', 'plugins');
    expandOrgScope.mockRejectedValue(new Error('mongo blip'));
    getParentOrgId.mockResolvedValue('root');

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000; // past the 60s TTL
    try {
      await expect(quotaService.incrementUsage('teamA', 'plugins', 1))
        .rejects.toBeInstanceOf(QuotaPoolUnavailableError);
    } finally {
      Date.now = realNow;
    }
    expect(outcomes()).toEqual(['denied']);
  });

  it('never serves the cache while resolution SUCCEEDS (enforcement stays exact)', async () => {
    await quotaService.getQuotaStatus('teamA', 'plugins'); // memoizes used 90

    // The pool genuinely drains to 10; the live read must win over the memo.
    find.mockReturnValue({
      select: () => ({
        lean: async () => [
          { ...poolRows[0], usage: { plugins: { used: 10, resetAt: future } } },
          { ...poolRows[1], usage: { plugins: { used: 0, resetAt: future } } },
        ],
      }),
    });

    const status = await quotaService.getQuotaStatus('teamA', 'plugins');
    expect(status).toMatchObject({ limit: 100, used: 10 });
    expect(outcomes()).toEqual([]);
  });
});
