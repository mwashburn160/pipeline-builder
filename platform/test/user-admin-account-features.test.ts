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

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetByIdWithOrgs = jest.fn<(...a: unknown[]) => unknown>();
const mockUpdateFeatures = jest.fn<(...a: unknown[]) => unknown>();
const mockHasMembershipInOrg = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockRequireAdminContext = jest.fn();
const mockOrgFindById = jest.fn();

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
  validateBulkArray: jest.fn(),
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
  return { Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

const mockAudit = jest.fn();
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
}));

// user-admin transitively imports utils/token via user-profile; mock so we
// don't pull in the real JWT signing path (which would demand env vars).
jest.unstable_mockModule('../src/utils/token.js', () => ({ issueTokens: jest.fn() }));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: jest.fn(),
  updateProfileSchema: {},
  changePasswordSchema: {},
  adminUpdateUserSchema: {},
  adminCreateUserSchema: {},
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAdminContext: (req: any, res: any) => mockRequireAdminContext(req, res),
  requireAuthUserId: jest.fn(),
  withController: (_label: string, fn: Function) => async (req: any, res: any) => fn(req, res),
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  userAdminService: {
    getByIdWithOrgs: (...a: unknown[]) => mockGetByIdWithOrgs(...a),
    updateFeatures: (...a: unknown[]) => mockUpdateFeatures(...a),
    hasMembershipInOrg: (...a: unknown[]) => mockHasMembershipInOrg(...a),
  },
  userProfileService: {},
  UA_USER_NOT_FOUND: 'UA_USER_NOT_FOUND',
  UA_USERNAME_TAKEN: 'UA_USERNAME_TAKEN',
  UA_EMAIL_TAKEN: 'UA_EMAIL_TAKEN',
  UA_OWNER_HAS_ORGS: 'UA_OWNER_HAS_ORGS',
  UA_ORG_NOT_FOUND: 'UA_ORG_NOT_FOUND',
  UA_SEAT_LIMIT: 'UA_SEAT_LIMIT',
  UA_CANNOT_CHANGE_OWNER: 'UA_CANNOT_CHANGE_OWNER',
  UA_ROLES_NEED_ORG: 'UA_ROLES_NEED_ORG',
  RL_ROLE_NOT_FOUND: 'RL_ROLE_NOT_FOUND',
  PROFILE_EMAIL_TAKEN: 'PROFILE_EMAIL_TAKEN',
  PROFILE_INVALID_CREDENTIALS: 'PROFILE_INVALID_CREDENTIALS',
  PROFILE_OWNER_HAS_ORGS: 'PROFILE_OWNER_HAS_ORGS',
  PROFILE_USER_NOT_FOUND: 'PROFILE_USER_NOT_FOUND',
}));

jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { passwordMinLength: 8 } } }));

const { getUserById, updateUserFeatures } = await import('../src/controllers/user-admin.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

/** `Organization.findById(id).select('featureEntitlements').lean()` stub. */
function orgLean(value: unknown) {
  return { select: () => ({ lean: () => value }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAdminContext.mockReturnValue({ isSuperAdmin: true, isOrgAdmin: false, adminType: 'system' });
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
      { user: { sub: 'admin' }, params: { id: 'user1' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0].data;
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
      { user: { sub: 'admin' }, params: { id: 'user1' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const call = mockResolveUserFeatures.mock.calls[0];
    expect(call[1]?.accountFeatures).toBeUndefined();
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
      { user: { sub: 'admin' }, params: { id: 'user1' }, body: { overrides: {} } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(payload.user.features).toContain('sso');
    const call = mockResolveUserFeatures.mock.calls[0];
    expect(call[1]?.accountFeatures).toEqual(['sso']);
  });

  it('audits the privileged feature-override edit with the changed field NAMES only', async () => {
    mockUpdateFeatures.mockResolvedValue({
      user: { _id: 'user1', username: 'alice', email: 'a@x.io', isSuperAdmin: false, isEmailVerified: true, lastActiveOrgId: 'org1' },
      organizationName: 'Acme',
      activeOrgRole: 'member',
      tier: 'pro',
    });
    mockOrgFindById.mockReturnValue(orgLean({ featureEntitlements: [] }));

    const req: any = { user: { sub: 'admin' }, params: { id: 'user1' }, body: { overrides: { audit_log: true, sso: false } } };
    await (updateUserFeatures as unknown as (r: any, s: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.user.features.update', expect.objectContaining({
      targetType: 'user',
      targetId: 'user1',
      details: { features: ['audit_log', 'sso'] },
    }));
  });
});
