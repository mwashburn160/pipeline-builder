// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the session-invalidation behavior of organization-quota's
 * setTier + setSeatLimit.
 *
 * The JWT bakes in the org's `tier` + resolved `features` (from `tier` +
 * `featureEntitlements`) at issue time. On an account change that REDUCES access
 * — a tier DOWNGRADE or a bundle (feature) removal — members' already-issued
 * tokens would keep granting the elevated tier / `requireFeature`-gated
 * capabilities (sso, audit_log, …) until natural expiry. Both paths therefore
 * bump every active member's `tokenVersion` (in the same transaction) ONLY on a
 * genuine reduction; an upgrade / feature-add leaves tokens alone (a stale token
 * then under-grants, which is safe).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const limits = (seats: number, plugins: number) => ({
  seats,
  plugins,
  pipelines: -1,
  apiCalls: -1,
  aiCalls: -1,
  storageBytes: -1,
  dashboards: -1,
  alertRules: -1,
  alertDestinations: -1,
  idpConfigs: -1,
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  QUOTA_TIERS: {
    developer: { label: 'Developer', limits: limits(1, 10) },
    pro: { label: 'Pro', limits: limits(3, 100) },
    team: { label: 'Team', limits: limits(10, 500) },
    enterprise: { label: 'Enterprise', limits: limits(-1, -1) },
  },
}));

jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

// Run the transaction body inline with a fake session (no live Mongo).
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { quota: { tier: { developer: {}, pro: {}, team: {}, enterprise: {} } } },
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));

const mockResolveOrgLineage = jest.fn<(...a: unknown[]) => Promise<{ rootOrgId: string }>>();
const mockExpandOrgScope = jest.fn<(...a: unknown[]) => Promise<string[]>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  resolveOrgLineage: mockResolveOrgLineage,
  expandOrgScope: mockExpandOrgScope,
}));

jest.unstable_mockModule('../src/helpers/seats.js', () => ({ pooledSeatUsage: jest.fn() }));

jest.unstable_mockModule('../src/middleware/quota.js', () => ({
  getOrganizationQuotaStatus: jest.fn(),
  updateQuotaLimits: jest.fn(),
  QuotaType: {},
}));

const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockOrgUpdateOne = jest.fn<(...a: unknown[]) => Promise<{ matchedCount: number }>>();
const mockOrgUpdateMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserUpdateMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserOrgDistinct = jest.fn<(...a: unknown[]) => { session: (s?: unknown) => Promise<unknown[]> }>();

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: (...a: unknown[]) => mockOrgFindById(...a),
    updateOne: (...a: unknown[]) => mockOrgUpdateOne(...a),
    updateMany: (...a: unknown[]) => mockOrgUpdateMany(...a),
  },
  User: { updateMany: (...a: unknown[]) => mockUserUpdateMany(...a) },
  UserOrganization: { distinct: (...a: unknown[]) => mockUserOrgDistinct(...a) },
}));

const { setTier, setSeatLimit } = await import('../src/services/organization-quota.js');

/** A Mongoose-shaped org doc for setTier (awaited directly by findById). */
function makeOrgDoc(initial: { _id: string; tier?: string; parentOrgId?: string; quotas?: unknown }) {
  return {
    _id: { toString: () => initial._id },
    tier: initial.tier,
    parentOrgId: initial.parentOrgId,
    quotas: initial.quotas,
    markModified: jest.fn(),
    save: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
  };
}

/** The $inc tokenVersion write, if it fired. */
const tokenBump = () =>
  mockUserUpdateMany.mock.calls.find((c) => (c[1] as any)?.$inc?.tokenVersion === 1);

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateMany.mockResolvedValue(undefined);
  mockOrgUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockOrgUpdateMany.mockResolvedValue(undefined);
  mockExpandOrgScope.mockResolvedValue(['root-1']); // flat: no descendant propagation
  mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'root-1' });
  mockUserOrgDistinct.mockReturnValue({ session: () => Promise.resolve(['u1', 'u2']) });
});

describe('setTier — tier downgrade invalidation', () => {
  it('bumps every active member on a DOWNGRADE (team → pro)', async () => {
    mockOrgFindById.mockResolvedValue(makeOrgDoc({ _id: 'root-1', tier: 'team', quotas: { plugins: 500 } }));

    await setTier('root-1', 'pro');

    const bump = tokenBump();
    expect(bump).toBeDefined();
    // Targeted at the active members resolved via UserOrganization.distinct.
    expect((bump![0] as any)).toEqual({ _id: { $in: ['u1', 'u2'] } });
    // Only active members are resolved for the bump.
    expect(mockUserOrgDistinct).toHaveBeenCalledWith('userId', { organizationId: 'root-1', isActive: true });
  });

  it('does NOT bump on an UPGRADE (pro → team)', async () => {
    mockOrgFindById.mockResolvedValue(makeOrgDoc({ _id: 'root-1', tier: 'pro', quotas: { plugins: 100 } }));

    await setTier('root-1', 'team');

    expect(tokenBump()).toBeUndefined();
  });

  it('does NOT bump on a legacy no-tier → tier transition', async () => {
    mockOrgFindById.mockResolvedValue(makeOrgDoc({ _id: 'root-1' }));

    await setTier('root-1', 'pro');

    expect(tokenBump()).toBeUndefined();
  });

  it('is a no-member no-op even on a downgrade (no User write)', async () => {
    mockUserOrgDistinct.mockReturnValue({ session: () => Promise.resolve([]) });
    mockOrgFindById.mockResolvedValue(makeOrgDoc({ _id: 'root-1', tier: 'enterprise', quotas: { plugins: -1 } }));

    await setTier('root-1', 'developer');

    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });
});

describe('setSeatLimit — feature (bundle) removal invalidation', () => {
  /** findById(...).select('featureEntitlements').session().lean() → current doc. */
  const currentFeatures = (features: string[]) =>
    mockOrgFindById.mockReturnValue({
      select: () => ({ session: () => ({ lean: () => Promise.resolve({ featureEntitlements: features }) }) }),
    });

  it('bumps every active member when a feature is REMOVED (sso dropped)', async () => {
    currentFeatures(['sso', 'audit_log']);

    await setSeatLimit('root-1', 5, ['audit_log']); // sso removed

    const bump = tokenBump();
    expect(bump).toBeDefined();
    expect((bump![0] as any)).toEqual({ _id: { $in: ['u1', 'u2'] } });
    expect(mockUserOrgDistinct).toHaveBeenCalledWith('userId', { organizationId: 'root-1', isActive: true });
  });

  it('does NOT bump when a feature is only ADDED', async () => {
    currentFeatures(['sso']);

    await setSeatLimit('root-1', 5, ['sso', 'audit_log']); // audit_log added

    expect(tokenBump()).toBeUndefined();
  });

  it('does NOT bump when the feature set is UNCHANGED', async () => {
    currentFeatures(['sso', 'audit_log']);

    await setSeatLimit('root-1', 5, ['audit_log', 'sso']); // same set, reordered

    expect(tokenBump()).toBeUndefined();
  });

  it('does NOT read entitlements or bump when features are omitted (seat-only update)', async () => {
    await setSeatLimit('root-1', 8);

    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(tokenBump()).toBeUndefined();
  });
});
