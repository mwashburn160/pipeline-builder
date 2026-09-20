// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org → team quota pooling in the quota service.
 *
 * - A FLAT org (no parent, no teams) resolves in the single self-or-children
 *   lookup and never walks the hierarchy (increment is the hottest path).
 * - A ROOT with teams reads and enforces the pooled subtree, exactly like its
 *   teams do (it used to short-circuit to its own usage only).
 * - A TEAM reads/enforces the root's limit against the whole subtree's usage.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const emitCounter = jest.fn();

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

// Spy hierarchy resolvers so we can assert exactly which ones each path invokes.
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

const findOneAndUpdate = jest.fn();
const findById = jest.fn();
const find = jest.fn();
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { findOneAndUpdate, findById, find },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quota: {
      resetDays: 30,
      // 0 ⇒ the last-known-cap fallback is OFF, so these suites exercise the
      // resolution paths directly; the fallback has its own suite.
      poolFallbackTtlMs: 0,
      defaults: { pipelines: 10, plugins: 10, apiCalls: 1000, aiCalls: 100 },
    },
  },
}));

const { quotaService } = await import('../src/services/quota-service.js');
const { QuotaPoolUnavailableError, clearPoolStatusCache } = await import('../src/services/pooled-quota.js');

const future = new Date(Date.now() + 86_400_000); // resetAt in the future (period live)
const past = new Date(Date.now() - 86_400_000); // expired period

// Atomic-increment success doc read back by incrementUsage on the per-org path.
const incrementedOrg = {
  quotas: { plugins: 100 },
  usage: { plugins: { used: 1, resetAt: future } },
};

/** root (limit 100, used 60) + teamA (used 30) + teamB (expired period, used 50 ⇒ 0). */
const poolRows = [
  { _id: 'root', name: 'Acme', tier: 'team', quotas: { plugins: 100, pipelines: 20, apiCalls: -1, storageBytes: 1000 }, usage: { plugins: { used: 60, resetAt: future }, pipelines: { used: 1, resetAt: future }, storageBytes: { used: 5, resetAt: future } } },
  { _id: 'teamA', name: 'Team A', tier: 'developer', quotas: { plugins: -1, pipelines: -1, apiCalls: -1, storageBytes: -1 }, usage: { plugins: { used: 30, resetAt: future }, pipelines: { used: 2, resetAt: future }, storageBytes: { used: 7, resetAt: future } } },
  { _id: 'teamB', name: 'Team B', tier: 'developer', quotas: { plugins: -1, pipelines: -1, apiCalls: -1 }, usage: { plugins: { used: 50, resetAt: past } } },
];

function poolFindReturns(rows: unknown[]) {
  find.mockReturnValue({ select: () => ({ lean: async () => rows }) });
}

/** Wire the hierarchy so `orgId` is the root (with teams) or a team of `root`. */
function asRoot() {
  findOrgWithHierarchy.mockResolvedValue({ self: poolRows[0], hasChildren: true });
  expandOrgScope.mockResolvedValue(['root', 'teamA', 'teamB']);
  poolFindReturns(poolRows);
}
function asTeam() {
  findOrgWithHierarchy.mockResolvedValue({ self: poolRows[1], parentOrgId: 'root', hasChildren: false });
  resolveRootOrgId.mockResolvedValue('root');
  expandOrgScope.mockResolvedValue(['root', 'teamA', 'teamB']);
  poolFindReturns(poolRows);
}

beforeEach(() => {
  jest.clearAllMocks();
  clearPoolStatusCache();
  findOneAndUpdate.mockResolvedValue(incrementedOrg);
});

describe('flat org (no parent, no teams)', () => {
  beforeEach(() => {
    findOrgWithHierarchy.mockResolvedValue({ self: { _id: 'org-flat', ...incrementedOrg }, hasChildren: false });
  });

  it('increment: one lookup, no hierarchy walk, straight to the atomic update', async () => {
    const result = await quotaService.incrementUsage('org-flat', 'plugins', 1);

    expect(findOrgWithHierarchy).toHaveBeenCalledTimes(1);
    expect(resolveRootOrgId).not.toHaveBeenCalled();
    expect(expandOrgScope).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(result.exceeded).toBe(false);
  });

  it('read: own numbers from the single lookup, no pool marker', async () => {
    findOrgWithHierarchy.mockResolvedValue({
      self: { _id: 'org-flat', name: 'Flat', slug: 'flat', tier: 'developer', ...incrementedOrg },
      hasChildren: false,
    });

    const quota = await quotaService.findByOrgId('org-flat');
    const status = await quotaService.getQuotaStatus('org-flat', 'plugins');

    expect(expandOrgScope).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(quota.pool).toBeUndefined();
    expect(quota.quotas.plugins).toMatchObject({ limit: 100, used: 1 });
    expect(status).toMatchObject({ limit: 100, used: 1 });
  });
});

describe('root org with teams', () => {
  beforeEach(asRoot);

  it('read: reports the pooled subtree (root limit, live usage summed, expired team period = 0)', async () => {
    const quota = await quotaService.findByOrgId('root');

    expect(expandOrgScope).toHaveBeenCalledWith('root');
    expect(resolveRootOrgId).not.toHaveBeenCalled(); // a root IS the pool root
    expect(quota.quotas.plugins).toMatchObject({ limit: 100, used: 90, remaining: 10 });
    expect(quota.quotas.pipelines).toMatchObject({ limit: 20, used: 3 });
    expect(quota.pool).toEqual({ rootOrgId: 'root', rootOrgName: 'Acme', isRoot: true, orgCount: 3 });
    expect(quota.tier).toBe('team');
  });

  it('status read: pooled numbers', async () => {
    const status = await quotaService.getQuotaStatus('root', 'plugins');
    expect(status).toMatchObject({ limit: 100, used: 90, remaining: 10, allowed: true });
  });

  it('increment at the pooled cap is refused (root was previously unchecked against the pool)', async () => {
    const result = await quotaService.incrementUsage('root', 'plugins', 11); // 90 + 11 > 100

    expect(result.exceeded).toBe(true);
    expect(result.quota).toMatchObject({ limit: 100, used: 90 });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('increment exactly filling the pooled cap proceeds to the atomic update', async () => {
    const result = await quotaService.incrementUsage('root', 'plugins', 10); // 90 + 10 == 100

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(result.exceeded).toBe(false);
  });

  it('storageBytes stays per-org (never pooled)', async () => {
    const quota = await quotaService.findByOrgId('root');
    expect(quota.quotas.storageBytes).toMatchObject({ limit: 1000, used: 5 }); // root's own, not 5 + 7
    findOneAndUpdate.mockResolvedValue({ quotas: { storageBytes: 1000 }, usage: { storageBytes: { used: 6, resetAt: future } } });
    const result = await quotaService.incrementUsage('root', 'storageBytes' as never, 1);
    expect(findOrgWithHierarchy).toHaveBeenCalledTimes(1); // only the read above
    expect(result.exceeded).toBe(false);
  });
});

describe('team org', () => {
  beforeEach(asTeam);

  it('read: the same pooled numbers the root sees, marked as a team of the root', async () => {
    const quota = await quotaService.findByOrgId('teamA');

    expect(resolveRootOrgId).toHaveBeenCalledWith('root'); // walks up from its parent
    expect(quota.orgId).toBe('teamA');
    expect(quota.quotas.plugins).toMatchObject({ limit: 100, used: 90 });
    expect(quota.pool).toEqual({ rootOrgId: 'root', rootOrgName: 'Acme', isRoot: false, orgCount: 3 });
    expect(quota.tier).toBe('team'); // inherited from the root
  });

  it('increment over the shared cap is refused', async () => {
    const result = await quotaService.incrementUsage('teamA', 'plugins', 11);
    expect(result.exceeded).toBe(true);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

});

/**
 * A team's OWN quota row is seeded -1 on EVERY dimension (only the root's
 * pooled cap is meant to bind) and the per-org atomic `$expr` short-circuits on
 * -1 — so "fall back to per-org enforcement" is not degraded enforcement, it is
 * NO enforcement. The pooled resolution failing must therefore DENY for a team,
 * while a root / flat org (whose own row carries real limits) is unaffected.
 */
describe('pooled-cap resolution FAILS', () => {
  const denialCounts = () => emitCounter.mock.calls.filter(
    (c) => c[0] === 'quota_pool_resolution_failed_total',
  ).map((c) => (c[1] as { outcome: string }).outcome);

  it('increment: a TEAM is DENIED (503), never silently unmetered', async () => {
    asTeam();
    expandOrgScope.mockRejectedValue(new Error('walk failed'));
    getParentOrgId.mockResolvedValue('root');

    await expect(quotaService.incrementUsage('teamA', 'plugins', 1))
      .rejects.toBeInstanceOf(QuotaPoolUnavailableError);
    // The per-org atomic update (which the -1 row would wave straight through)
    // is never reached.
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(denialCounts()).toContain('denied');
  });

  it('increment: denies even when the parent PROBE also fails (fail closed)', async () => {
    asTeam();
    expandOrgScope.mockRejectedValue(new Error('walk failed'));
    getParentOrgId.mockRejectedValue(new Error('mongo down'));

    await expect(quotaService.incrementUsage('teamA', 'plugins', 1))
      .rejects.toBeInstanceOf(QuotaPoolUnavailableError);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('increment: a FLAT org is unaffected — its own row still enforces', async () => {
    findOrgWithHierarchy.mockRejectedValue(new Error('lookup failed'));
    getParentOrgId.mockResolvedValue(undefined);

    const result = await quotaService.incrementUsage('org-flat', 'plugins', 1);

    expect(result.exceeded).toBe(false);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(denialCounts()).toEqual(['own_limits']);
  });

  it('increment: a ROOT is unaffected — its own row carries the real limits', async () => {
    asRoot();
    expandOrgScope.mockRejectedValue(new Error('walk failed'));
    getParentOrgId.mockResolvedValue(undefined);

    const result = await quotaService.incrementUsage('root', 'plugins', 1);

    expect(result.exceeded).toBe(false);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(denialCounts()).toEqual(['own_limits']);
  });

  it('status read: a TEAM raises rather than reporting its own -1 as "unlimited"', async () => {
    asTeam();
    expandOrgScope.mockRejectedValue(new Error('walk failed'));

    await expect(quotaService.getQuotaStatus('teamA', 'plugins'))
      .rejects.toBeInstanceOf(QuotaPoolUnavailableError);
  });

  it('status read: a ROOT falls back to its own numbers', async () => {
    asRoot();
    expandOrgScope.mockRejectedValue(new Error('walk failed'));

    const status = await quotaService.getQuotaStatus('root', 'plugins');
    expect(status).toMatchObject({ limit: 100, used: 60 });
  });

  it('org read: a TEAM raises; a ROOT reports its own numbers', async () => {
    asTeam();
    expandOrgScope.mockRejectedValue(new Error('walk failed'));
    await expect(quotaService.findByOrgId('teamA')).rejects.toBeInstanceOf(QuotaPoolUnavailableError);

    asRoot();
    expandOrgScope.mockRejectedValue(new Error('walk failed'));
    const quota = await quotaService.findByOrgId('root');
    expect(quota.quotas.plugins).toMatchObject({ limit: 100, used: 60 });
    expect(quota.pool).toBeUndefined();
  });

  it('storageBytes is never pooled, so a walk failure cannot deny it', async () => {
    asTeam();
    expandOrgScope.mockRejectedValue(new Error('walk failed'));
    const status = await quotaService.getQuotaStatus('teamA', 'storageBytes');
    expect(status.limit).toBe(-1); // the team's own row — storage is registry-enforced
  });
});
