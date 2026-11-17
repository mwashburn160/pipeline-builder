// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * resolveMembership drift-proofing: a TEAM member's JWT bakes in the ACCOUNT's
 * feature entitlements, which pool at the ROOT. A team's own org doc carries
 * only a DENORMALIZED copy that can lag propagation (concurrent team-create, a
 * partially-applied propagation write). resolveMembership therefore reads a
 * parented org's `featureEntitlements` from the ROOT — never the stale team-doc
 * copy — so the token can't over/under-grant `requireFeature`-gated capabilities
 * on a drift window. A flat/root org (the active doc IS the root) is unchanged
 * and pays no extra DB read.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import jwt from 'jsonwebtoken';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: {
    jwt: { secret: 'test-secret', algorithm: 'HS256', expiresIn: 3600, tierExpiresIn: {} },
    refreshToken: { secret: 'test-refresh-secret', expiresIn: 86400 },
  },
}));

// A SHARED logger stub (rather than loggerMock's fresh-spies-per-call default) so
// the token module's `createLogger('token')` instance is capturable — the degrade
// path must log at WARN.
const mockLogger = { info: jest.fn<AnyFn>(), warn: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), debug: jest.fn<AnyFn>() };

// resolveUserFeatures is stubbed to surface exactly the account features it was
// handed, so the JWT `features` claim IS the resolved account entitlement set —
// letting us assert which doc (root vs. stale team) it was sourced from.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // Enabled per-user overrides are appended so the per-org override tests can
  // see exactly which org's overrides were applied.
  resolveUserFeatures: (_tier: string, opts?: { accountFeatures?: readonly string[]; overrides?: Record<string, boolean> }) => [
    ...(opts?.accountFeatures ?? []),
    ...Object.entries(opts?.overrides ?? {}).filter(([, on]) => on).map(([k]) => k),
  ],
  createLogger: () => mockLogger,
}));

const mockResolveOrgLineage = jest.fn<(...a: any[]) => Promise<{ rootOrgId: string; parentOrgId?: string }>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: async () => false,
  resolveOrgLineage: mockResolveOrgLineage,
  // org-authority walks up for inherited admin authority; a flat org has no parent.
  getParentOrgId: async () => undefined,
}));

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

const mockOrgFindById = jest.fn<(...a: any[]) => unknown>();
const mockUserOrgFindOne = jest.fn<(...a: any[]) => unknown>();
const mockUserOrgFind = jest.fn<(...a: any[]) => unknown>();
const emptyRoleChain = () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) });

// Refresh-session slots live behind session-store.ts (their own collection).
const { sessionStoreFake } = await import('./helpers/session-store-fake.js');
jest.unstable_mockModule('../src/services/session/session-store.js', () => sessionStoreFake());

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { updateOne: jest.fn(async () => ({})) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUserOrgFindOne(...a),
    find: (...a: unknown[]) => mockUserOrgFind(...a),
  },
  Role: { find: emptyRoleChain },
  RoleAssignment: { find: emptyRoleChain },
}));

const { signInAuth } = await import('../src/services/session/access-tokens.js');
const { issueTokens } = await import('../src/services/session/refresh-sessions.js');
const { installTestSigningKeys } = await import('./helpers/signing.js');
installTestSigningKeys();

/** Every sign-in opens an interactive slot; these tests only care about claims. */
const login = { kind: 'interactive' as const, auth: signInAuth('pwd') };

function mockUser(extra: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'user-1' },
    username: 'u',
    email: 'u@example.com',
    isEmailVerified: true,
    tokenVersion: 1,
    ...extra,
  } as unknown as Parameters<typeof issueTokens>[0];
}

// findById(id).select(...).lean() → the doc registered for `id` (or null).
function registerDocs(docs: Record<string, unknown>) {
  mockOrgFindById.mockImplementation((id: string) => ({
    select: () => ({ lean: () => Promise.resolve(docs[id] ?? null) }),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveMembership — featureEntitlements resolve from the account ROOT', () => {
  it("a TEAM member's JWT features come from the ROOT, not the stale team-doc copy", async () => {
    // Active team membership. The team doc's denormalized entitlements are STALE
    // (only `stale_only`); the ROOT holds the authoritative account set.
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve({ role: 'member', organizationId: 'team-1' }) });
    registerDocs({
      'team-1': { name: 'Team', tier: 'team', parentOrgId: 'root-1', featureEntitlements: ['stale_only'], deletedAt: null },
      'root-1': { featureEntitlements: ['sso', 'audit_log'] },
    });
    mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'root-1', parentOrgId: 'root-1' });

    const { accessToken } = await issueTokens(mockUser(), 'team-1', login);
    const decoded = jwt.decode(accessToken) as Record<string, unknown>;

    // Structurally drift-proof: the ROOT's set, never the team doc's stale copy.
    expect(decoded.features).toEqual(['sso', 'audit_log']);
    expect(decoded.features as string[]).not.toContain('stale_only');
    // Hierarchy claims still ride the SAME lineage walk (resolved once).
    expect(decoded.rootOrganizationId).toBe('root-1');
    expect(decoded.parentOrganizationId).toBe('root-1');
    expect(mockResolveOrgLineage).toHaveBeenCalledTimes(1);
  });

  it('degrades to the team-doc copy (not a collapsed membership) when the ROOT read REJECTS', async () => {
    // Active team membership. The team doc's own denormalized entitlements are the
    // graceful fallback when the authoritative ROOT read blips transiently.
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve({ role: 'member', organizationId: 'team-1' }) });
    mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'root-1', parentOrgId: 'root-1' });
    // The team doc resolves; the ROOT read (root-1) REJECTS — a transient blip.
    mockOrgFindById.mockImplementation((id: string) => ({
      select: () => ({
        lean: () =>
          id === 'root-1'
            ? Promise.reject(new Error('root read blip'))
            : Promise.resolve({ name: 'Team', tier: 'team', parentOrgId: 'root-1', featureEntitlements: ['team_copy'], deletedAt: null }),
      }),
    }));

    const { accessToken } = await issueTokens(mockUser(), 'team-1', login);
    const decoded = jwt.decode(accessToken) as Record<string, unknown>;

    // Graceful degrade: the JWT carries the team doc's own (possibly stale) copy —
    // NOT a collapsed/undefined membership that strands the member with no org.
    expect(decoded.features).toEqual(['team_copy']);
    expect(decoded.organizationId).toBe('team-1');
    expect(decoded.role).toBe('member');
    // Hierarchy claims still ride the lineage walk (which succeeded).
    expect(decoded.rootOrganizationId).toBe('root-1');
    expect(decoded.parentOrganizationId).toBe('root-1');
    // The degrade is logged at WARN for observability.
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toMatch(/root featureEntitlements read failed/i);
  });

  it('a FLAT/root org uses its OWN featureEntitlements (no lineage walk, no extra read)', async () => {
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve({ role: 'owner', organizationId: 'root-1' }) });
    registerDocs({
      'root-1': { name: 'Root', tier: 'pro', parentOrgId: null, featureEntitlements: ['ai_generation'], deletedAt: null },
    });

    const { accessToken } = await issueTokens(mockUser(), 'root-1', login);
    const decoded = jwt.decode(accessToken) as Record<string, unknown>;

    expect(decoded.features).toEqual(['ai_generation']);
    // Flat org: the active doc IS the root — no LINEAGE WALK. Three org reads:
    // the membership context, the MFA policy and the session-lifetime policy
    // (helpers/session-policy.ts), both resolved at the same chokepoint and
    // likewise costing no walk for a flat org.
    expect(mockResolveOrgLineage).not.toHaveBeenCalled();
    expect(mockOrgFindById).toHaveBeenCalledTimes(3);
    expect(decoded.rootOrganizationId).toBeUndefined();
    expect(decoded.parentOrganizationId).toBeUndefined();
  });
});

describe('per-user feature overrides are scoped to the ACTIVE org', () => {
  // The user belongs to two flat orgs. org-A's admin granted `audit_log` (an
  // override in org-A's entry only); org-B has its own, different entry.
  const overrides = new Map([
    ['org-a', new Map([['audit_log', true]])],
    ['org-b', new Map([['ai_generation', true], ['audit_log', false]])],
  ]);

  beforeEach(() => {
    mockUserOrgFindOne.mockImplementation((q: { organizationId: string }) => ({
      lean: () => Promise.resolve({ role: 'member', organizationId: q.organizationId }),
    }));
    registerDocs({
      'org-a': { name: 'A', tier: 'pro', parentOrgId: null, featureEntitlements: [], deletedAt: null },
      'org-b': { name: 'B', tier: 'pro', parentOrgId: null, featureEntitlements: [], deletedAt: null },
      'org-c': { name: 'C', tier: 'pro', parentOrgId: null, featureEntitlements: [], deletedAt: null },
    });
  });

  it("REGRESSION: an org-A admin's override does not reach the user's org-B token", async () => {
    const { accessToken } = await issueTokens(mockUser({ featureOverrides: overrides }), 'org-b', login);
    const decoded = jwt.decode(accessToken) as Record<string, unknown>;

    expect(decoded.organizationId).toBe('org-b');
    expect(decoded.features).toEqual(['ai_generation']);
    expect(decoded.features as string[]).not.toContain('audit_log');
  });

  it("the org-A token carries org-A's override", async () => {
    const { accessToken } = await issueTokens(mockUser({ featureOverrides: overrides }), 'org-a', login);
    const decoded = jwt.decode(accessToken) as Record<string, unknown>;

    expect(decoded.features).toEqual(['audit_log']);
  });

  it('an org with no entry gets no overrides at all', async () => {
    const { accessToken } = await issueTokens(mockUser({ featureOverrides: overrides }), 'org-c', login);
    const decoded = jwt.decode(accessToken) as Record<string, unknown>;

    expect(decoded.features).toEqual([]);
  });
});
