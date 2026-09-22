// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * FIX 1 regression: admin user views must reflect PURCHASED account
 * entitlements.
 *
 * `resolveUserFeatures(tier, { overrides, isSuperAdmin, accountFeatures })`
 * takes the org's purchased entitlements (add-on bundles like `sso`/`audit_log`)
 * via its named `accountFeatures` option. The admin `getUserById` /
 * `updateUserFeatures` responses used
 * to OMIT it, so their computed feature set excluded purchased features and
 * diverged from what the user's real token carries (token.ts passes it).
 *
 * These tests assert the controller now sources the active org's
 * `featureEntitlements` (via the Organization model, the same source token.ts
 * reads) and threads it into `resolveUserFeatures`, so `sso` shows up in the
 * response.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetByIdWithOrgs = jest.fn<AnyFn>();
const mockUpdateFeatures = jest.fn<AnyFn>();
const mockHasMembershipInOrg = jest.fn<AnyFn>();
const mockOrgFindById = jest.fn<AnyFn>();

// Faithful mini resolver: union tier-less start + account features, then apply
// overrides. Enough to assert purchased features land in the response AND that
// the `accountFeatures` option is actually passed.
const mockResolveUserFeatures = jest.fn(
  (_tier: unknown, opts?: { overrides?: Record<string, boolean> | null; isSuperAdmin?: boolean; accountFeatures?: readonly string[] | null }) => {
    const { overrides, accountFeatures } = opts ?? {};
    const set = new Set<string>(accountFeatures ?? []);
    if (overrides) for (const [k, v] of Object.entries(overrides)) { if (v) set.add(k); else set.delete(k); }
    return [...set].sort();
  },
);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  resolveUserFeatures: (...a: unknown[]) => (mockResolveUserFeatures as unknown as (...x: unknown[]) => unknown)(...a),
  isValidFeatureFlag: () => true,
  validateBulkArray: jest.fn<AnyFn>(),
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
  return { Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn<AnyFn>() };
});

const mockAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  // Linking stub only — the barrel's `User` is pulled in transitively by the
  // profile helpers the user-admin controller imports.
  User: {},
}));

// user-admin transitively imports utils/token via user-profile; mock so we
// don't pull in the real JWT signing path (which would demand env vars).
jest.unstable_mockModule('../src/utils/token.js', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  enforceOrgAssurance: async (_u: unknown, _m: unknown, a: unknown) => a,
  // Session-auth helpers the controllers now import (see utils/token.ts).
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  findRefreshSession: jest.fn(async () => undefined),
  signApiKeyToken: jest.fn<AnyFn>(),
  signServiceAccountToken: jest.fn<AnyFn>(),
  membershipForOrg: jest.fn(async () => undefined),
  issueTokens: jest.fn<AnyFn>(),
  renewSessionTokens: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: jest.fn<AnyFn>(),
  updateProfileSchema: {},
  changePasswordSchema: {},
  adminUpdateUserSchema: {},
  adminCreateUserSchema: {},
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

jest.unstable_mockModule('../src/services/index.js', () => ({
  userAdminService: {
    getByIdWithOrgs: (...a: unknown[]) => mockGetByIdWithOrgs(...a),
    updateFeatures: (...a: unknown[]) => mockUpdateFeatures(...a),
    hasMembershipInOrg: (...a: unknown[]) => mockHasMembershipInOrg(...a),
  },
  userProfileService: {},
  // Linking stub: user-profile.js (loaded transitively) imports the key service.
  apiKeyService: {},
}));

jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { passwordMinLength: 8 } } }));

// A user's SAML SLO sessions go with the user (user-cascade imports the model directly).
jest.unstable_mockModule('../src/models/saml-session.js', () => ({ default: { deleteMany: async () => ({ deletedCount: 0 }) } }));
// The password-policy helper reads platform config at import (user-profile imports it).
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  PASSWORD_MAX_LENGTH: 128,
  passwordPolicyForPerson: async () => ({ minLength: 8 }),
  assertNewPasswordAcceptable: async () => undefined,
  passwordShortfall: async () => null,
}));

const { getUserById, updateUserFeatures } = await import('../src/controllers/user-admin.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

// `requireMemberManagementScope` runs FOR REAL (helpers/controller-helper-mock.ts):
// no `req.user` → 401; api-core's `isSystemAdmin` (the JWT `isSuperAdmin` claim)
// → `{ isSuperAdmin: true }`; otherwise the caller's `organizationId` →
// `{ isSuperAdmin: false, orgId }`. Authority lives in the FIXTURE below.
/** A platform administrator — fleet-wide scope. */
const SYSADMIN = { sub: 'admin', isSuperAdmin: true };
/** An org admin holding `members:manage`, scoped to `orgA`. */
const ORG_ADMIN = { sub: 'admin', organizationId: 'orgA', role: 'admin' };

/** `Organization.findById(id).select('featureEntitlements').lean()` stub. */
function orgLean(value: unknown) {
  return { select: () => ({ lean: () => value }) };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getUserById — purchased account features', () => {
  it("includes the org's purchased `sso` entitlement in the response features", async () => {
    mockGetByIdWithOrgs.mockResolvedValue({
      user: { _id: 'user1', username: 'alice', email: 'a@x.io', isSuperAdmin: false, isEmailVerified: true, lastActiveOrgId: 'org1' },
      memberships: [{ organizationId: 'org1', role: 'member' }],
      orgMap: new Map([['org1', { _id: 'org1', name: 'Acme', slug: 'acme', tier: 'pro' }]]),
    });
    // Active org carries a purchased add-on bundle granting `sso`.
    mockOrgFindById.mockReturnValue(orgLean({ featureEntitlements: ['sso'] }));

    const res = mockRes();
    await (getUserById as unknown as (req: any, res: any) => Promise<void>)(
      { user: SYSADMIN, params: { id: 'user1' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock<AnyFn>).mock.calls[0][0].data;
    expect(payload.user.features).toContain('sso');

    // The `accountFeatures` option was actually threaded through — this is the
    // dropped-arg regression the fix addresses.
    const call = mockResolveUserFeatures.mock.calls[0];
    expect(call[1]?.accountFeatures).toEqual(['sso']);
  });

  it('resolves without account features when the org has none', async () => {
    mockGetByIdWithOrgs.mockResolvedValue({
      user: { _id: 'user1', username: 'bob', email: 'b@x.io', isSuperAdmin: false, isEmailVerified: true, lastActiveOrgId: 'org1' },
      memberships: [{ organizationId: 'org1', role: 'member' }],
      orgMap: new Map([['org1', { _id: 'org1', name: 'Acme', slug: 'acme', tier: 'developer' }]]),
    });
    mockOrgFindById.mockReturnValue(orgLean(null));

    const res = mockRes();
    await (getUserById as unknown as (req: any, res: any) => Promise<void>)(
      { user: SYSADMIN, params: { id: 'user1' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const call = mockResolveUserFeatures.mock.calls[0];
    expect(call[1]?.accountFeatures).toBeUndefined();
  });
});

describe('the member-management scope gate bites', () => {
  it('401s an unauthenticated caller before any lookup', async () => {
    const res = mockRes();
    await (getUserById as unknown as (req: any, res: any) => Promise<void>)(
      { params: { id: 'user1' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockGetByIdWithOrgs).not.toHaveBeenCalled();
  });

  it('403s a caller with `members:manage` but no active organization', async () => {
    const res = mockRes();
    await (updateUserFeatures as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'nomad' }, params: { id: 'user1' }, body: { overrides: { sso: true } } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockUpdateFeatures).not.toHaveBeenCalled();
  });

  it('403s an org admin reaching at a user outside their organization', async () => {
    mockGetByIdWithOrgs.mockResolvedValue({
      user: { _id: 'user1', username: 'alice', email: 'a@x.io', isSuperAdmin: false, isEmailVerified: true, lastActiveOrgId: 'orgB' },
      memberships: [{ organizationId: 'orgB', role: 'member' }],
      orgMap: new Map(),
    });
    mockHasMembershipInOrg.mockResolvedValue(false);

    const res = mockRes();
    await (getUserById as unknown as (req: any, res: any) => Promise<void>)(
      { user: ORG_ADMIN, params: { id: 'user1' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockHasMembershipInOrg).toHaveBeenCalledWith('user1', 'orgA');
  });
});

describe('updateUserFeatures — purchased account features', () => {
  it("includes the org's purchased `sso` entitlement in the updated response", async () => {
    mockUpdateFeatures.mockResolvedValue({
      user: { _id: 'user1', username: 'alice', email: 'a@x.io', isSuperAdmin: false, isEmailVerified: true, lastActiveOrgId: 'org1' },
      organizationName: 'Acme',
      activeOrgRole: 'member',
      tier: 'pro',
    });
    mockOrgFindById.mockReturnValue(orgLean({ featureEntitlements: ['sso'] }));

    const res = mockRes();
    await (updateUserFeatures as unknown as (req: any, res: any) => Promise<void>)(
      { user: SYSADMIN, params: { id: 'user1' }, body: { overrides: {} } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock<AnyFn>).mock.calls[0][0].data;
    expect(payload.user.features).toContain('sso');
    const call = mockResolveUserFeatures.mock.calls[0];
    expect(call[1]?.accountFeatures).toEqual(['sso']);
  });

  it('REJECTS an org admin enabling an entitlement-gated feature not in the org tier/entitlements', async () => {
    // SECURITY (privilege-escalation regression): an org admin must not be able to
    // override-enable `sso` (a paid add-on) when the org's tier doesn't include it
    // and it hasn't been purchased — that bypasses billing AND (since
    // featureOverrides is a GLOBAL field) leaks into the target's other orgs.
    mockHasMembershipInOrg.mockResolvedValue(true);
    // Admin's org: developer tier, no purchased entitlements → `sso` is gated.
    mockOrgFindById.mockReturnValue(orgLean({ tier: 'developer', featureEntitlements: [] }));

    const res = mockRes();
    const req: any = { user: ORG_ADMIN, params: { id: 'user1' }, body: { overrides: { sso: true } } };
    await (updateUserFeatures as unknown as (r: any, s: any) => Promise<void>)(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    // The write must never be attempted.
    expect(mockUpdateFeatures).not.toHaveBeenCalled();
  });

  it('ALLOWS an org admin enabling a feature the org has purchased (in featureEntitlements)', async () => {
    mockHasMembershipInOrg.mockResolvedValue(true);
    // Admin's org purchased the `sso` add-on → the override is permitted.
    mockOrgFindById.mockReturnValue(orgLean({ tier: 'developer', featureEntitlements: ['sso'] }));
    mockUpdateFeatures.mockResolvedValue({
      user: { _id: 'user1', username: 'alice', email: 'a@x.io', isSuperAdmin: false, isEmailVerified: true, lastActiveOrgId: 'orgA' },
      organizationName: 'Acme',
      activeOrgRole: 'member',
      tier: 'developer',
    });

    const res = mockRes();
    const req: any = { user: ORG_ADMIN, params: { id: 'user1' }, body: { overrides: { sso: true } } };
    await (updateUserFeatures as unknown as (r: any, s: any) => Promise<void>)(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUpdateFeatures).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS a system admin to enable a gated feature (gate is org-admin-only)', async () => {
    mockOrgFindById.mockReturnValue(orgLean({ tier: 'developer', featureEntitlements: [] }));
    mockUpdateFeatures.mockResolvedValue({
      user: { _id: 'user1', username: 'alice', email: 'a@x.io', isSuperAdmin: false, isEmailVerified: true, lastActiveOrgId: 'orgA' },
      organizationName: 'Acme',
      activeOrgRole: 'member',
      tier: 'developer',
    });

    const res = mockRes();
    const req: any = { user: SYSADMIN, params: { id: 'user1' }, body: { overrides: { sso: true } } };
    await (updateUserFeatures as unknown as (r: any, s: any) => Promise<void>)(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUpdateFeatures).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS an org admin to DISABLE a gated feature (removing is never an escalation)', async () => {
    mockHasMembershipInOrg.mockResolvedValue(true);
    mockOrgFindById.mockReturnValue(orgLean({ tier: 'developer', featureEntitlements: [] }));
    mockUpdateFeatures.mockResolvedValue({
      user: { _id: 'user1', username: 'alice', email: 'a@x.io', isSuperAdmin: false, isEmailVerified: true, lastActiveOrgId: 'orgA' },
      organizationName: 'Acme',
      activeOrgRole: 'member',
      tier: 'developer',
    });

    const res = mockRes();
    const req: any = { user: ORG_ADMIN, params: { id: 'user1' }, body: { overrides: { sso: false } } };
    await (updateUserFeatures as unknown as (r: any, s: any) => Promise<void>)(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUpdateFeatures).toHaveBeenCalledTimes(1);
  });

  it('audits the privileged feature-override edit with the changed field NAMES only', async () => {
    mockUpdateFeatures.mockResolvedValue({
      user: { _id: 'user1', username: 'alice', email: 'a@x.io', isSuperAdmin: false, isEmailVerified: true, lastActiveOrgId: 'org1' },
      organizationName: 'Acme',
      activeOrgRole: 'member',
      tier: 'pro',
    });
    mockOrgFindById.mockReturnValue(orgLean({ featureEntitlements: [] }));

    const req: any = { user: SYSADMIN, params: { id: 'user1' }, body: { overrides: { audit_log: true, sso: false } } };
    await (updateUserFeatures as unknown as (r: any, s: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.user.features.update', expect.objectContaining({
      targetType: 'user',
      targetId: 'user1',
      details: { features: ['audit_log', 'sso'] },
    }));
  });
});
