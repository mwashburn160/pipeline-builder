// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * QuotaService paths the pooled / route suites don't reach: the unpooled own
 * read, registry storage filling, tier-aware defaults for a missing stored
 * limit, and the refund edge cases (flat snapshot, unresolvable pool, a team's
 * own counter failing to follow).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { MOCK_TIER_NAMES, mockQuotaTiers } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/**
 * EVERY real tier, not just the two this suite spells numbers for.
 *
 * `defaultLimitExpr` emits one `$switch` branch per `QUOTA_TIERS` key, and the
 * fixture used to carry two — so the branch assertion below compared two
 * branches and would have passed against an implementation that silently
 * dropped the rest of the ladder. `mockQuotaTiers` fills the tiers a suite does
 * not care about with uncapped limits, so the map is exhaustive over the real
 * `VALID_TIERS` without hand-listing six tiers' worth of numbers here.
 */
const QUOTA_TIERS = mockQuotaTiers({
  developer: { plugins: 10, automationCalls: 20_000, storageBytes: 1000 },
  pro: { plugins: 25, automationCalls: 50_000, storageBytes: 5000 },
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isValidTier: () => true,
  ValidationError: class ValidationError extends Error {},
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'automationCalls', 'storageBytes'],
  QUOTA_TIERS,
  VALID_TIERS: [...MOCK_TIER_NAMES],
}));

type Lookup = { self: unknown; parentOrgId?: string; hasChildren: boolean };
const findOrgWithHierarchy = jest.fn<(id: string, fields: string) => Promise<Lookup>>();
const resolveRootOrgId = jest.fn<(id: string) => Promise<string>>();
const expandOrgScope = jest.fn<(id: string) => Promise<string[]>>();
const getParentOrgId = jest.fn<(id: string) => Promise<string | undefined>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  findOrgWithHierarchy, resolveRootOrgId, expandOrgScope, getParentOrgId,
}));

const findOneAndUpdate = jest.fn<AnyFn>();
const findById = jest.fn<AnyFn>();
const find = jest.fn<AnyFn>();
const updateOne = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { findOneAndUpdate, findById, find, updateOne },
}));

const fetchStorageBytes = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({ fetchStorageBytes }));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { resetDays: 3, poolFallbackTtlMs: 0, defaults: { plugins: 10, automationCalls: 20_000, storageBytes: 1000 } } },
}));

const { quotaService } = await import('../src/services/quota-service.js');
const { defaultLimitFor, defaultLimitExpr } = await import('../src/helpers/quota-helpers.js');

const future = new Date(Date.now() + 86_400_000);
const leanOnce = (row: unknown) => ({ select: () => ({ lean: async () => row }) });

beforeEach(() => {
  jest.clearAllMocks();
  fetchStorageBytes.mockResolvedValue(null);
  updateOne.mockResolvedValue({ acknowledged: true });
});

describe('tier-aware defaults for a missing stored limit', () => {
  it('reads the org\'s TIER preset, falling back to the unprovisioned default', () => {
    expect(defaultLimitFor('pro', 'automationCalls')).toBe(50_000);
    expect(defaultLimitFor('nonsense', 'automationCalls')).toBe(20_000);
    expect(defaultLimitFor(undefined, 'plugins')).toBe(10);
  });

  it('builds the same choice as a Mongo $switch over $tier — one branch per tier', () => {
    // Expected branches are derived from the real tier NAME list against the
    // fixture's limits, so this fails if the expression stops covering a tier.
    // Hand-listing them is what let a two-tier fixture pass as complete.
    expect(defaultLimitExpr('automationCalls')).toEqual({
      $switch: {
        branches: MOCK_TIER_NAMES.map((tier) => ({
          case: { $eq: ['$tier', tier] },
          then: QUOTA_TIERS[tier].limits.automationCalls,
        })),
        default: 20_000,
      },
    });
    // Guards the derivation itself: six tiers today, and never silently one.
    expect(MOCK_TIER_NAMES.length).toBeGreaterThan(2);
  });

  it('a Pro org with no stored automationCalls limit is read at Pro\'s preset', async () => {
    findOrgWithHierarchy.mockResolvedValue({
      self: { _id: 'o', name: 'O', slug: 'o', tier: 'pro', quotas: { plugins: 25 }, usage: {} },
      hasChildren: false,
    });
    const quota = await quotaService.findByOrgId('o');
    expect(quota.quotas.automationCalls.limit).toBe(50_000);
    expect(quota.periodDays).toBe(3);
  });
});

describe('findOwnByOrgId (unpooled)', () => {
  it('returns the org\'s own row with no pool overlay', async () => {
    findById.mockReturnValue(leanOnce({ _id: 'team-a', name: 'A', slug: 'a', tier: 'pro', quotas: { plugins: -1 }, usage: { plugins: { used: 4, resetAt: future } } }));
    const quota = await quotaService.findOwnByOrgId('team-a');
    expect(quota.quotas.plugins).toMatchObject({ limit: -1, used: 4 });
    expect(quota.pool).toBeUndefined();
    expect(findOrgWithHierarchy).not.toHaveBeenCalled();
  });

  it('a missing org reads as the default response', async () => {
    findById.mockReturnValue(leanOnce(null));
    expect((await quotaService.findOwnByOrgId('ghost')).isDefault).toBe(true);
  });
});

describe('registry storage filling', () => {
  const flat = { _id: 'o', name: 'O', slug: 'o', tier: 'developer', quotas: { storageBytes: 1000 }, usage: {} };

  it('fills a flat org\'s storageBytes.used from the registry', async () => {
    findOrgWithHierarchy.mockResolvedValue({ self: flat, hasChildren: false });
    fetchStorageBytes.mockResolvedValue(400);
    const quota = await quotaService.findByOrgId('o');
    expect(fetchStorageBytes).toHaveBeenCalledWith(['o']);
    expect(quota.quotas.storageBytes).toMatchObject({ used: 400, remaining: 600 });
  });

  it('a pool reports its whole subtree against the pooled cap', async () => {
    findOrgWithHierarchy.mockResolvedValue({ self: flat, hasChildren: true });
    expandOrgScope.mockResolvedValue(['o', 't']);
    find.mockReturnValue({ select: () => ({ lean: async () => [{ ...flat, quotas: { storageBytes: -1 } }, { _id: 't', usage: {} }] }) });
    fetchStorageBytes.mockResolvedValue(5_000);
    const quota = await quotaService.findByOrgId('o');
    expect(fetchStorageBytes).toHaveBeenCalledWith(['o', 't']);
    expect(quota.quotas.storageBytes).toMatchObject({ used: 5_000, remaining: -1 });
  });

  it('an unmeasurable registry, or a failing scope walk, leaves 0', async () => {
    findOrgWithHierarchy.mockResolvedValue({ self: flat, hasChildren: false });
    expect((await quotaService.findByOrgId('o')).quotas.storageBytes.used).toBe(0);
    fetchStorageBytes.mockRejectedValue(new Error('boom'));
    expect((await quotaService.findByOrgId('o')).quotas.storageBytes.used).toBe(0);
  });
});

describe('refund edge cases', () => {
  it('flat org: snapshot match applies; mismatch reports current state as not applied; gone → null', async () => {
    findOrgWithHierarchy.mockResolvedValue({ self: { _id: 'o' }, hasChildren: false });

    findOneAndUpdate.mockResolvedValueOnce({ tier: 'developer', quotas: { plugins: 10 }, usage: { plugins: { used: 2, resetAt: future } } });
    expect(await quotaService.decrementUsage('o', 'plugins', 1, { resetAtSnapshot: future.toISOString() }))
      .toMatchObject({ applied: true, rootOrgId: 'o', quota: { used: 2 } });
    expect((findOneAndUpdate.mock.calls[0] as [Record<string, unknown>])[0].$expr).toBeDefined();

    findOneAndUpdate.mockResolvedValueOnce(null);
    findById.mockResolvedValueOnce({ tier: 'developer', quotas: {}, usage: {} });
    expect(await quotaService.decrementUsage('o', 'plugins', 1, { resetAtSnapshot: future.toISOString() }))
      .toMatchObject({ applied: false, quota: { limit: 10, used: 0 } });

    findOneAndUpdate.mockResolvedValueOnce(null);
    findById.mockResolvedValueOnce(null);
    expect(await quotaService.decrementUsage('o', 'plugins', 1, { resetAtSnapshot: future.toISOString() })).toBeNull();

    findOneAndUpdate.mockResolvedValueOnce(null);
    expect(await quotaService.decrementUsage('o', 'plugins', 1)).toBeNull();
  });

  it('a team whose root is unresolvable still refunds its own counter (a refund never 503s)', async () => {
    findOrgWithHierarchy.mockResolvedValue({ self: { _id: 't' }, parentOrgId: 'root', hasChildren: false });
    resolveRootOrgId.mockRejectedValue(new Error('walk failed'));
    getParentOrgId.mockResolvedValue('root');
    findOneAndUpdate.mockResolvedValue({ quotas: {}, usage: { plugins: { used: 0, resetAt: future } } });

    const result = await quotaService.decrementUsage('t', 'plugins', 1);
    expect(result).toMatchObject({ applied: true, rootOrgId: 't' });
    expect((findOneAndUpdate.mock.calls[0] as [Record<string, unknown>])[0]._id).toBe('t');
  });

  it('an unexpected refund failure is NOT swallowed', async () => {
    findOrgWithHierarchy.mockResolvedValue({ self: { _id: 't' }, parentOrgId: 'root', hasChildren: false });
    resolveRootOrgId.mockResolvedValue('root');
    findOneAndUpdate.mockRejectedValue(new Error('mongo down'));
    await expect(quotaService.decrementUsage('t', 'plugins', 1)).rejects.toThrow('mongo down');
  });

  it('a team\'s own counter failing to follow never undoes a granted increment or refund', async () => {
    findOrgWithHierarchy.mockResolvedValue({ self: { _id: 't' }, parentOrgId: 'root', hasChildren: false });
    resolveRootOrgId.mockResolvedValue('root');
    updateOne.mockRejectedValue(new Error('team write failed'));
    findOneAndUpdate.mockResolvedValue({ tier: 'pro', quotas: {}, poolUsage: { plugins: { used: 3, resetAt: future } } });

    expect(await quotaService.incrementUsage('t', 'plugins', 1)).toMatchObject({ exceeded: false, quota: { limit: 25, used: 3 } });
    expect(await quotaService.decrementUsage('t', 'plugins', 1)).toMatchObject({ applied: true, quota: { used: 3 } });
  });

  it('a pooled refusal against a vanished root is OrgNotFound; a refund against one is null', async () => {
    findOrgWithHierarchy.mockResolvedValue({ self: { _id: 't' }, parentOrgId: 'root', hasChildren: false });
    resolveRootOrgId.mockResolvedValue('root');
    findOneAndUpdate.mockResolvedValue(null);
    findById.mockReturnValue(leanOnce(null));
    await expect(quotaService.incrementUsage('t', 'plugins', 1)).rejects.toThrow('Organization not found: root');
    expect(await quotaService.decrementUsage('t', 'plugins', 1)).toBeNull();
  });
});

describe('admin reset', () => {
  it('zeroes a pool root\'s pooled counter along with its own', async () => {
    const save = jest.fn<AnyFn>(async () => undefined);
    const org = {
      _id: 'root',
      name: 'R',
      slug: 'r',
      tier: 'pro',
      quotas: { plugins: 25 },
      usage: { plugins: { used: 9, resetAt: future } },
      poolUsage: { plugins: { used: 20, resetAt: future } },
      save,
    };
    findById.mockResolvedValue(org);
    await quotaService.resetUsage('root', 'plugins');
    expect(org.usage.plugins.used).toBe(0);
    expect(org.poolUsage.plugins.used).toBe(0);
    expect(save).toHaveBeenCalled();
  });
});
