// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `organizationService.list` — focused on the recently-added
 * `tier` filter and the `kmsConfigured` / `idpConfigured` derived
 * fields that drive the sysadmin orgs page facets.
 *
 * Mongoose chain shape:
 *   Organization.find(filter).populate(...).sort(...).skip(n).limit(m).lean()
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockOrgFind = jest.fn();
const mockOrgFindById = jest.fn();
const mockOrgCount = jest.fn();
const mockUserOrgCount = jest.fn();
const mockIdpFind = jest.fn();
const mockIdpDistinct = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  decryptSecret: jest.fn(),
  encryptSecret: jest.fn(),
  isEncryptedBlob: jest.fn(() => false),
  // `organization-service.setTier` now reseeds quotas from QUOTA_TIERS so
  // every QuotaTierLimits field stays in lockstep with api-core. Mirror the
  // real shape — `setTier` does `{...QUOTA_TIERS[newTier].limits}`. The
  // tier-config in this file's `../src/config` mock supplies the numeric
  // shape the *list* tests assert on; this QUOTA_TIERS mock supplies the
  // shape `setTier` actually spreads into `org.quotas`.
  QUOTA_TIERS: {
    developer: {
      label: 'Developer',
      limits: {
        plugins: 10,
        pipelines: 5,
        apiCalls: 1000,
        aiCalls: 100,
        storageBytes: 1073741824,
        dashboards: 5,
        alertRules: 5,
        alertDestinations: 5,
        idpConfigs: 1,
      },
    },
    pro: {
      label: 'Pro',
      limits: {
        plugins: 100,
        pipelines: 50,
        apiCalls: 10000,
        aiCalls: 1000,
        storageBytes: 107374182400,
        dashboards: 200,
        alertRules: 500,
        alertDestinations: 50,
        idpConfigs: 5,
      },
    },
    unlimited: {
      label: 'Unlimited',
      limits: {
        plugins: -1,
        pipelines: -1,
        apiCalls: -1,
        aiCalls: -1,
        storageBytes: -1,
        dashboards: -1,
        alertRules: -1,
        alertDestinations: -1,
        idpConfigs: -1,
      },
    },
  },
}));

jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    pre() { /* no-op */ }
    post() { /* no-op */ }
    virtual() { return this; }
    set() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  return { default: { startSession: jest.fn() }, Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

jest.unstable_mockModule('../src/middleware/quota.js', () => ({
  getOrganizationQuotaStatus: jest.fn(),
  updateQuotaLimits: jest.fn(),
  QuotaType: {},
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    quota: {
      tier: {
        developer: { plugins: 10, pipelines: 5, apiCalls: 1000, aiCalls: 100 },
        pro: { plugins: 100, pipelines: 50, apiCalls: 10000, aiCalls: 1000 },
        unlimited: { plugins: -1, pipelines: -1, apiCalls: -1, aiCalls: -1 },
      },
    },
  },
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    find: (...a: unknown[]) => mockOrgFind(...a),
    findById: (...a: unknown[]) => mockOrgFindById(...a),
    countDocuments: (...a: unknown[]) => mockOrgCount(...a),
  },
  User: { updateOne: jest.fn() },
  UserOrganization: { countDocuments: (...a: unknown[]) => mockUserOrgCount(...a), create: jest.fn() },
  OrgIdpConfig: {
    find: (...a: unknown[]) => mockIdpFind(...a),
    exists: jest.fn(),
  },
  // Consumed transitively via organization-service.js -> groups-service.js.
  Group: { create: jest.fn(), find: jest.fn(), findOne: jest.fn(), exists: jest.fn() },
  GroupMembership: { create: jest.fn(), find: jest.fn(), exists: jest.fn(), countDocuments: jest.fn() },
}));

const { organizationService } = await import('../src/services/organization-service.js');


// Build a chain matching Organization.find(...).populate(...).sort(...).skip(...).limit(...).lean()
function makeFindChain(rows: unknown[]) {
  const chain: any = {};
  chain.populate = jest.fn(() => chain);
  chain.sort = jest.fn(() => chain);
  chain.skip = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve(rows));
  return chain;
}

beforeEach(() => {
  mockOrgFind.mockReset();
  mockOrgFindById.mockReset();
  mockOrgCount.mockReset();
  mockUserOrgCount.mockReset();
  mockIdpFind.mockReset();
  mockIdpDistinct.mockReset();
  mockIdpFind.mockReturnValue({ distinct: () => mockIdpDistinct() });
  mockIdpDistinct.mockResolvedValue([]);
});

describe('organizationService.list — tier filter + derived facets', () => {
  it('does not filter by tier when no tier argument is passed', async () => {
    mockOrgFind.mockReturnValue(makeFindChain([]));
    mockOrgCount.mockResolvedValue(0);

    await organizationService.list({ offset: 0, limit: 10 });
    expect(mockOrgFind).toHaveBeenCalledWith({});
  });

  it('adds the tier predicate to the Mongo filter when provided', async () => {
    mockOrgFind.mockReturnValue(makeFindChain([]));
    mockOrgCount.mockResolvedValue(0);

    await organizationService.list({ tier: 'pro', offset: 0, limit: 10 });
    expect(mockOrgFind).toHaveBeenCalledWith({ tier: 'pro' });
  });

  it('combines search regex with the tier filter', async () => {
    mockOrgFind.mockReturnValue(makeFindChain([]));
    mockOrgCount.mockResolvedValue(0);

    await organizationService.list({ search: 'acme', tier: 'unlimited', offset: 0, limit: 10 });
    expect(mockOrgFind).toHaveBeenCalledWith({
      $or: [
        { name: { $regex: 'acme', $options: 'i' } },
        { slug: { $regex: 'acme', $options: 'i' } },
      ],
      tier: 'unlimited',
    });
  });

  it('derives kmsConfigured=true iff kmsConfig.keyId is present', async () => {
    const rows = [
      { _id: 'o1', name: 'a', slug: 'a', kmsConfig: { keyId: 'alias/x' } },
      { _id: 'o2', name: 'b', slug: 'b' },
      { _id: 'o3', name: 'c', slug: 'c', kmsConfig: {} },
    ];
    mockOrgFind.mockReturnValue(makeFindChain(rows));
    mockOrgCount.mockResolvedValue(3);
    mockUserOrgCount.mockResolvedValue(0);

    const { organizations } = await organizationService.list({ offset: 0, limit: 10 });
    expect(organizations.map((o) => [o.id, o.kmsConfigured])).toEqual([
      ['o1', true],
      ['o2', false],
      ['o3', false],
    ]);
  });

  it('derives idpConfigured by intersecting page ids with OrgIdpConfig.distinct()', async () => {
    const rows = [
      { _id: 'o1', name: 'a', slug: 'a' },
      { _id: 'o2', name: 'b', slug: 'b' },
      { _id: 'o3', name: 'c', slug: 'c' },
    ];
    mockOrgFind.mockReturnValue(makeFindChain(rows));
    mockOrgCount.mockResolvedValue(3);
    mockUserOrgCount.mockResolvedValue(0);
    // Only o1 and o3 have an IdP doc on file.
    mockIdpDistinct.mockResolvedValue(['o1', 'o3']);

    const { organizations } = await organizationService.list({ offset: 0, limit: 10 });
    expect(organizations.map((o) => [o.id, o.idpConfigured])).toEqual([
      ['o1', true],
      ['o2', false],
      ['o3', true],
    ]);
  });

  it('echoes the org tier on each summary row when present', async () => {
    mockOrgFind.mockReturnValue(makeFindChain([
      { _id: 'o1', name: 'a', slug: 'a', tier: 'pro' },
      { _id: 'o2', name: 'b', slug: 'b' },
    ]));
    mockOrgCount.mockResolvedValue(2);
    mockUserOrgCount.mockResolvedValue(0);

    const { organizations } = await organizationService.list({ offset: 0, limit: 10 });
    expect(organizations[0].tier).toBe('pro');
    expect(organizations[1].tier).toBeUndefined();
  });
});

describe('organizationService.setTier', () => {
  // Helper: build a Mongoose-shaped doc with markModified + save spies so we
  // can assert the writes actually fired (not just the in-memory mutation).
  function makeOrgDoc(initial: { _id: string; tier?: string; quotas?: unknown }) {
    return {
      _id: initial._id,
      tier: initial.tier,
      quotas: initial.quotas,
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as { _id: string; tier?: string; quotas?: unknown; markModified: jest.Mock; save: jest.Mock };
  }

  it('returns null when the org does not exist', async () => {
    mockOrgFindById.mockResolvedValue(null);
    const result = await organizationService.setTier('missing-org', 'pro');
    expect(result).toBeNull();
  });

  it('is a no-op when newTier equals existing tier', async () => {
    const org = makeOrgDoc({ _id: 'o1', tier: 'pro', quotas: { plugins: 100 } });
    mockOrgFindById.mockResolvedValue(org);

    const result = await organizationService.setTier('o1', 'pro');

    expect(result).toEqual({ id: 'o1', previousTier: 'pro', tier: 'pro' });
    expect(org.save).not.toHaveBeenCalled();
    expect(org.markModified).not.toHaveBeenCalled();
  });

  it('updates tier and reseeds quotas from the new tier config', async () => {
    const org = makeOrgDoc({ _id: 'o1', tier: 'developer', quotas: { plugins: 10 } });
    mockOrgFindById.mockResolvedValue(org);

    const result = await organizationService.setTier('o1', 'pro');

    expect(result).toEqual({ id: 'o1', previousTier: 'developer', tier: 'pro' });
    expect(org.tier).toBe('pro');
    // Quotas reseeded from QUOTA_TIERS.pro.limits — schema requires every
    // QuotaTierLimits field (storageBytes/dashboards/etc.), so the spread
    // brings them all over.
    expect(org.quotas).toEqual({
      plugins: 100,
      pipelines: 50,
      apiCalls: 10000,
      aiCalls: 1000,
      storageBytes: 107374182400,
      dashboards: 200,
      alertRules: 500,
      alertDestinations: 50,
      idpConfigs: 5,
    });
    expect(org.markModified).toHaveBeenCalledWith('quotas');
    expect(org.save).toHaveBeenCalled();
  });

  it('handles transition from no-tier to a real tier', async () => {
    // Pre-existing org with no tier field set yet (legacy data).
    const org = makeOrgDoc({ _id: 'o1' });
    mockOrgFindById.mockResolvedValue(org);

    const result = await organizationService.setTier('o1', 'unlimited');

    expect(result?.previousTier).toBeUndefined();
    expect(result?.tier).toBe('unlimited');
    expect(org.tier).toBe('unlimited');
    // QUOTA_TIERS.unlimited: every limit -1.
    expect(org.quotas).toEqual({
      plugins: -1,
      pipelines: -1,
      apiCalls: -1,
      aiCalls: -1,
      storageBytes: -1,
      dashboards: -1,
      alertRules: -1,
      alertDestinations: -1,
      idpConfigs: -1,
    });
  });

  it('saves without reseeding quotas if no tier config exists', async () => {
    // Unknown tier passed in (TypeScript would normally reject this; testing
    // the config-lookup guard). This branch keeps the system safe if the
    // tier vocab and the quota config drift apart.
    const org = makeOrgDoc({ _id: 'o1', tier: 'developer', quotas: { plugins: 10 } });
    mockOrgFindById.mockResolvedValue(org);

    const result = await organizationService.setTier('o1', 'ghost-tier' as never);
    expect(result?.tier).toBe('ghost-tier');
    // quotas unchanged since the tier config lookup returned undefined.
    expect(org.quotas).toEqual({ plugins: 10 });
    expect(org.markModified).not.toHaveBeenCalledWith('quotas');
    expect(org.save).toHaveBeenCalled();
  });
});

describe('organizationService.checkParentEligible — team nesting (org → team hierarchy)', () => {
  // Chain: Organization.findById(toOrgId(id)).select('parentOrgId').lean()
  const findByIdReturns = (doc: unknown) =>
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) });

  it('returns "not-found" when the parent does not exist', async () => {
    findByIdReturns(null);
    expect(await organizationService.checkParentEligible('missing')).toBe('not-found');
  });

  it('returns "ok" when the parent is a root org (no parentOrgId)', async () => {
    findByIdReturns({ parentOrgId: null });
    expect(await organizationService.checkParentEligible('root-1')).toBe('ok');
  });

  it('returns "not-root" when the parent is itself a team (one nesting level max)', async () => {
    findByIdReturns({ parentOrgId: 'root-1' });
    expect(await organizationService.checkParentEligible('team-1')).toBe('not-root');
  });
});
