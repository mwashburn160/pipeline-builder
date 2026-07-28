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

// The post-commit revocation publish — asserted to cover every affected member.
const mockPublishUsersRevocation = jest.fn<(...a: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUsersRevocation: mockPublishUsersRevocation,
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
  mockPublishUsersRevocation.mockResolvedValue(undefined);
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

  it('bumps members across the WHOLE subtree (root + descendant team) on a downgrade', async () => {
    // Root with one descendant team: the tier label propagates to the team, so
    // the token bump must cover BOTH orgs' members (deduped by `distinct`).
    mockExpandOrgScope.mockResolvedValue(['root-1', 'team-1']);
    mockUserOrgDistinct.mockReturnValue({ session: () => Promise.resolve(['u1', 'u2', 'u3']) });
    mockOrgFindById.mockResolvedValue(makeOrgDoc({ _id: 'root-1', tier: 'team', quotas: { plugins: 500 } }));

    await setTier('root-1', 'pro');

    const bump = tokenBump();
    expect(bump).toBeDefined();
    // Union of root + team members (distinct already deduped) is invalidated.
    expect((bump![0] as any)).toEqual({ _id: { $in: ['u1', 'u2', 'u3'] } });
    // The distinct query spans the entire subtree via `$in`, not just the root.
    expect(mockUserOrgDistinct).toHaveBeenCalledWith('userId', {
      organizationId: { $in: ['root-1', 'team-1'] },
      isActive: true,
    });
    // The revocation publish covers every affected user.
    expect(mockPublishUsersRevocation).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
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

  it('does NOT issue a descendant featureEntitlements updateMany when the set is UNCHANGED (idempotent re-sync)', async () => {
    // Root WITH a descendant team; the re-synced feature set matches the current
    // one (reordered), so the redundant subtree propagate write must be skipped.
    mockExpandOrgScope.mockResolvedValue(['root-1', 'team-1']);
    currentFeatures(['sso', 'audit_log']);

    await setSeatLimit('root-1', 5, ['audit_log', 'sso']); // same set, reordered

    // No descendant featureEntitlements rewrite (no updateMany at all here).
    expect(mockOrgUpdateMany).not.toHaveBeenCalled();
    // And still no token bump (nothing was reduced).
    expect(tokenBump()).toBeUndefined();
  });

  it('does NOT read entitlements or bump when features are omitted (seat-only update)', async () => {
    await setSeatLimit('root-1', 8);

    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(tokenBump()).toBeUndefined();
  });

  it('bumps members across the WHOLE subtree (root + descendant team) when a feature is removed', async () => {
    // featureEntitlements propagate to every descendant team, so removing
    // `advanced_reporting` must invalidate stale tokens held by ANY subtree
    // member — root AND team — not just the root's members.
    mockExpandOrgScope.mockResolvedValue(['root-1', 'team-1']);
    mockUserOrgDistinct.mockReturnValue({ session: () => Promise.resolve(['u1', 'u2', 'u3']) });
    currentFeatures(['advanced_reporting', 'audit_log']);

    await setSeatLimit('root-1', 5, ['audit_log']); // advanced_reporting removed

    const bump = tokenBump();
    expect(bump).toBeDefined();
    expect((bump![0] as any)).toEqual({ _id: { $in: ['u1', 'u2', 'u3'] } });
    // The distinct query spans the whole subtree, not just the root.
    expect(mockUserOrgDistinct).toHaveBeenCalledWith('userId', {
      organizationId: { $in: ['root-1', 'team-1'] },
      isActive: true,
    });
    // Descendant teams also received the propagated (shrunk) entitlement set.
    expect(mockOrgUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['team-1'] } },
      { $set: { featureEntitlements: ['audit_log'] } },
      expect.anything(),
    );
    // The post-commit publish covers every affected member (union, deduped).
    expect(mockPublishUsersRevocation).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
  });
});

describe('setSeatLimit — tier downgrade invalidation (billing tier push)', () => {
  /** findById(...).select('featureEntitlements tier').session().lean() → current. */
  const currentDoc = (tier: string, features: string[] = []) =>
    mockOrgFindById.mockReturnValue({
      select: () => ({ session: () => ({ lean: () => Promise.resolve({ tier, featureEntitlements: features }) }) }),
    });

  it('sets the tier label + reseeds non-seat quotas and bumps the subtree on a DOWNGRADE (team → pro)', async () => {
    mockExpandOrgScope.mockResolvedValue(['root-1', 'team-1']);
    mockUserOrgDistinct.mockReturnValue({ session: () => Promise.resolve(['u1', 'u2', 'u3']) });
    currentDoc('team');

    await setSeatLimit('root-1', 5, undefined, 'pro');

    // Root write carries the tier label + the pushed seat value.
    const set = (mockOrgUpdateOne.mock.calls[0][1] as any).$set;
    expect(set.tier).toBe('pro');
    expect(set['quotas.seats']).toBe(5);
    // Tier label propagated to the descendant team.
    expect(mockOrgUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['team-1'] } },
      { $set: { tier: 'pro' } },
      expect.anything(),
    );
    // Downgrade → stale tokens across the whole subtree invalidated + published.
    expect(tokenBump()).toBeDefined();
    expect(mockPublishUsersRevocation).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
  });

  it('reseeds org.quotas NON-SEAT dims from the new tier base while preserving the pushed seat value', async () => {
    // Degraded-read consistency: after a tier-push, `getQuotas`' quota-service-down
    // fallback reads limits off `org.quotas`, so those non-seat dims must track the
    // NEW tier — else they report the OLD tier's caps under the new label.
    currentDoc('team'); // team → pro downgrade

    await setSeatLimit('root-1', 5, undefined, 'pro');

    const set = (mockOrgUpdateOne.mock.calls[0][1] as any).$set;
    // seats stays the billing-pushed effective value — NOT clobbered by pro's base (3).
    expect(set['quotas.seats']).toBe(5);
    // Non-seat dims reseeded from pro's base (plugins 100; the rest -1).
    expect(set['quotas.plugins']).toBe(100);
    expect(set['quotas.pipelines']).toBe(-1);
    expect(set['quotas.apiCalls']).toBe(-1);
    expect(set['quotas.aiCalls']).toBe(-1);
    // Written via dot-notation — never a whole-object `quotas` (would conflict with
    // the `quotas.seats` key) and never a stray `quotas.seats` from the tier base.
    expect(set.quotas).toBeUndefined();
  });

  it('does NOT reseed quotas when the tier is UNCHANGED (seat-only within a tier)', async () => {
    currentDoc('pro');

    await setSeatLimit('root-1', 7, undefined, 'pro');

    const set = (mockOrgUpdateOne.mock.calls[0][1] as any).$set;
    expect(set['quotas.seats']).toBe(7);
    expect(set.tier).toBeUndefined();
    expect(set['quotas.plugins']).toBeUndefined();
  });

  it('does NOT bump on an UPGRADE (pro → team) but still sets the tier label', async () => {
    currentDoc('pro');

    await setSeatLimit('root-1', 5, undefined, 'team');

    expect((mockOrgUpdateOne.mock.calls[0][1] as any).$set.tier).toBe('team');
    expect(tokenBump()).toBeUndefined();
  });

  it('leaves the tier untouched (no $set, no bump) when unchanged', async () => {
    currentDoc('pro');

    await setSeatLimit('root-1', 5, undefined, 'pro');

    expect((mockOrgUpdateOne.mock.calls[0][1] as any).$set.tier).toBeUndefined();
    expect(tokenBump()).toBeUndefined();
  });

  it('uses the SCALAR distinct query for a flat-org (no-descendant) downgrade', async () => {
    // Default scope is ['root-1'] (no descendants), so the bump must target the
    // scalar organizationId, not a single-element $in.
    currentDoc('team');

    await setSeatLimit('root-1', 5, undefined, 'pro');

    expect(tokenBump()).toBeDefined();
    expect(mockUserOrgDistinct).toHaveBeenCalledWith('userId', { organizationId: 'root-1', isActive: true });
  });

  it('bumps ONCE when a feature shrink and a tier downgrade happen together', async () => {
    // Both reductions feed one `if (featureShrink || tierDowngrade)` — a single
    // bump, and both fields propagate to descendants in one $set.
    mockExpandOrgScope.mockResolvedValue(['root-1', 'team-1']);
    mockUserOrgDistinct.mockReturnValue({ session: () => Promise.resolve(['u1', 'u2', 'u3']) });
    currentDoc('team', ['advanced_reporting', 'audit_log']);

    await setSeatLimit('root-1', 5, ['audit_log'], 'pro'); // advanced_reporting dropped AND team→pro

    // Exactly one tokenVersion bump write (not one per reduction).
    const bumps = mockUserUpdateMany.mock.calls.filter((c) => (c[1] as any)?.$inc?.tokenVersion === 1);
    expect(bumps).toHaveLength(1);
    // Both the shrunk features AND the new tier propagate to the team in one write.
    expect(mockOrgUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['team-1'] } },
      { $set: { featureEntitlements: ['audit_log'], tier: 'pro' } },
      expect.anything(),
    );
    expect(mockPublishUsersRevocation).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
  });

  it('returns null and never bumps when the root org is missing (matchedCount 0)', async () => {
    currentDoc('team');
    mockOrgUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });

    const result = await setSeatLimit('root-1', 5, undefined, 'pro');

    expect(result).toBeNull();
    expect(tokenBump()).toBeUndefined();
    expect(mockPublishUsersRevocation).toHaveBeenCalledWith([]);
  });
});
