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

const findOneAndUpdate = jest.fn<AnyFn>();
const findById = jest.fn<AnyFn>();
const find = jest.fn<AnyFn>();
const updateOne = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { findOneAndUpdate, findById, find, updateOne },
}));

// Registry storage reads are their own suite; nothing here talks to a registry.
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({
  fetchStorageBytes: async () => null,
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

/** `findById(root).select(...).lean()` — the pooled refusal's read-back of the root. */
function rootReadBack(row: unknown) {
  findById.mockReturnValue({ select: () => ({ lean: async () => row }) });
}

/** The root as the pooled refusal reads it back: pool counter at 90 of 100. */
const rootAtNinety = {
  tier: 'team',
  quotas: { plugins: 100 },
  usage: { plugins: { used: 60, resetAt: future } },
  poolUsage: { plugins: { used: 90, resetAt: future } },
};

beforeEach(() => {
  jest.clearAllMocks();
  clearPoolStatusCache();
  findOneAndUpdate.mockResolvedValue(incrementedOrg);
  updateOne.mockResolvedValue({ acknowledged: true });
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

  it('read: the root\'s atomic pool counter wins over the sum of own usage once it has started', async () => {
    poolFindReturns([{ ...poolRows[0], poolUsage: { plugins: { used: 97, resetAt: future } } }, poolRows[1], poolRows[2]]);
    const quota = await quotaService.findByOrgId('root');
    expect(quota.quotas.plugins).toMatchObject({ limit: 100, used: 97, remaining: 3 });
  });

  it('increment at the pooled cap is refused by the ONE conditional update on the root', async () => {
    findOneAndUpdate.mockResolvedValue(null); // the $expr guard did not match
    rootReadBack(rootAtNinety);

    const result = await quotaService.incrementUsage('root', 'plugins', 11); // 90 + 11 > 100

    expect(result.exceeded).toBe(true);
    expect(result.quota).toMatchObject({ limit: 100, used: 90 });
    expect(result.rootOrgId).toBe('root');
    // No subtree pre-read: enforcement is the single guarded write.
    expect(find).not.toHaveBeenCalled();
    expect(expandOrgScope).not.toHaveBeenCalled();
    const [filter] = findOneAndUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(filter._id).toBe('root');
    expect(filter.$expr).toBeDefined();
  });

  it('increment as the root moves the pool counter AND its own counter in the same update', async () => {
    findOneAndUpdate.mockResolvedValue({ quotas: { plugins: 100 }, poolUsage: { plugins: { used: 100, resetAt: future } } });

    const result = await quotaService.incrementUsage('root', 'plugins', 10); // 90 + 10 == 100

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, stages] = findOneAndUpdate.mock.calls[0] as [unknown, Array<{ $set: Record<string, unknown> }>];
    // BOTH stages capture `limitAtPeriodStart` — the cap the period began with,
    // so a mid-period downgrade or a cancelled pack cannot strand an account over
    // a cap it already spent against. The pooled half matters MOST: a root with
    // teams is the account most likely to buy and cancel packs, so protecting
    // only the per-org counter would have put the protection on the wrong one.
    // `pooledStatusFromRows` reads the pooled snapshot, `computeQuotaStatus` the
    // per-org one; both take the max and both short-circuit `-1`.
    expect(Object.keys(stages[0].$set)).toEqual(['poolUsage.plugins.used', 'poolUsage.plugins.resetAt', 'poolUsage.plugins.limitAtPeriodStart']);
    expect(Object.keys(stages[1].$set)).toEqual(['usage.plugins.used', 'usage.plugins.resetAt', 'usage.plugins.limitAtPeriodStart']);
    expect(updateOne).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exceeded: false, rootOrgId: 'root', quota: { limit: 100, used: 100 } });
  });

  it('storageBytes reports the ROOT limit (usage is registry-measured, so it is not the point)', async () => {
    // The LIMIT is pooled like every other dimension — that is what the registry
    // push gate reads. The pooled `used` is summed for consistency but carries
    // no weight in production: nothing ever increments usage.storageBytes.
    const quota = await quotaService.findByOrgId('root');
    expect(quota.quotas.storageBytes).toMatchObject({ limit: 1000 });
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

  it('increment over the shared cap is refused at the ROOT, and the team\'s own counter never moves', async () => {
    findOneAndUpdate.mockResolvedValue(null);
    rootReadBack(rootAtNinety);

    const result = await quotaService.incrementUsage('teamA', 'plugins', 11);

    expect(result).toMatchObject({ exceeded: true, rootOrgId: 'root', quota: { limit: 100, used: 90 } });
    expect((findOneAndUpdate.mock.calls[0] as [Record<string, unknown>])[0]._id).toBe('root');
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('a granted increment lands on the root\'s pool counter, then the team\'s own counter follows', async () => {
    findOneAndUpdate.mockResolvedValue({ quotas: { plugins: 100 }, poolUsage: { plugins: { used: 91, resetAt: future } } });

    const result = await quotaService.incrementUsage('teamA', 'plugins', 1);

    expect(result).toMatchObject({ exceeded: false, rootOrgId: 'root', quota: { used: 91, resetAt: future.toISOString() } });
    const [, stages] = findOneAndUpdate.mock.calls[0] as [unknown, unknown[]];
    expect(stages).toHaveLength(1); // the pool stage only — the team's own row is a separate doc
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect((updateOne.mock.calls[0] as [Record<string, unknown>])[0]).toEqual({ _id: 'teamA' });
  });

  it('CONCURRENT increments from many teams admit exactly the remaining pooled capacity', async () => {
    // A faithful single-document atomic counter: Mongo evaluates the filter and
    // applies the update as one step. The old shape (sum the subtree, then
    // increment the team's own row) let every racer pass the pre-check.
    let used = 95;
    const limit = 100;
    findOneAndUpdate.mockImplementation(async (_filter: unknown, _stages: unknown, _opts: unknown) => {
      await new Promise((r) => setImmediate(r));
      if (used + 1 > limit) return null;
      used += 1;
      return { quotas: { plugins: limit }, poolUsage: { plugins: { used, resetAt: future } } };
    });
    rootReadBack({ ...rootAtNinety, poolUsage: { plugins: { used: 100, resetAt: future } } });

    const results = await Promise.all(Array.from({ length: 20 }, () => quotaService.incrementUsage('teamA', 'plugins', 1)));

    expect(results.filter((r) => !r.exceeded)).toHaveLength(5);
    expect(results.filter((r) => r.exceeded)).toHaveLength(15);
    expect(used).toBe(100);
    expect(find).not.toHaveBeenCalled(); // no racy subtree pre-read anywhere
  });

  it('refund: gives back the root\'s pool counter (snapshot-guarded) and then the team\'s own', async () => {
    findOneAndUpdate.mockResolvedValue({ quotas: { plugins: 100 }, poolUsage: { plugins: { used: 89, resetAt: future } } });

    const result = await quotaService.decrementUsage('teamA', 'plugins', 1, { resetAtSnapshot: future.toISOString() });

    const [filter] = findOneAndUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(filter._id).toBe('root');
    expect(filter.$expr).toEqual({ $eq: ['$poolUsage.plugins.resetAt', future] });
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ applied: true, rootOrgId: 'root', quota: { used: 89 } });
  });

  it('refund after the pool period rolled over gives nothing back (applied: false)', async () => {
    findOneAndUpdate.mockResolvedValue(null);
    rootReadBack(rootAtNinety);

    const result = await quotaService.decrementUsage('teamA', 'plugins', 1, { resetAtSnapshot: past.toISOString() });

    expect(result).toMatchObject({ applied: false, rootOrgId: 'root' });
    expect(updateOne).not.toHaveBeenCalled();
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
    resolveRootOrgId.mockRejectedValue(new Error('walk failed'));
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
    findOrgWithHierarchy.mockRejectedValue(new Error('lookup failed'));
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
    findOrgWithHierarchy.mockRejectedValue(new Error('lookup failed'));
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

  it('storageBytes denies for a TEAM too — its own row is the -1 that caused the bug', async () => {
    // storageBytes used to be exempt here, reporting the team's own -1. The
    // registry push gate reads `limit` and treats a negative as genuinely
    // unlimited, so every team could push without bound past the root's storage
    // cap. Only the USAGE half of storage is unpooled (nothing increments it);
    // the LIMIT follows the same fail-closed rule as every other dimension.
    asTeam();
    expandOrgScope.mockRejectedValue(new Error('walk failed'));
    await expect(quotaService.getQuotaStatus('teamA', 'storageBytes'))
      .rejects.toBeInstanceOf(QuotaPoolUnavailableError);
  });
});
