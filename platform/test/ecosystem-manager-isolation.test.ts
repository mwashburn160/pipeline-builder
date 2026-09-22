// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system-org-only permission class (docs/permissions.md): a TENANT org can never obtain the Ecosystem Manager role or its
 * permissions (`plugins:moderate`, `publishers:verify`) through ANY path.
 *
 * One suite, one row per path, so a reviewer can see the whole boundary:
 *   - seed        — `seedDefaultRoles` seeds it only when `isSystemOrg` (roles-service.test.ts);
 *   - custom Role — `sanitizePermissions` refuses the permissions in every org, for every actor;
 *   - assignment  — only a superadmin, and only inside the system org;
 *   - invite      — an invite's Member floor never resolves to the Ecosystem Manager;
 *   - IdP mapping — a directory mapping may never grant it;
 *   - token       — a token minted in a tenant org never CLAIMS the permissions,
 *                   even when a hand-written Role document carries them there,
 *                   and not even for a superadmin.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const SYSTEM = '000000000000000000000001';
const TENANT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ECOSYSTEM = ['plugins:moderate', 'publishers:verify'];

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: {
    jwt: { secret: 'test-secret', algorithm: 'HS256', expiresIn: 3600, tierExpiresIn: {} },
    refreshToken: { secret: 'test-refresh-secret', expiresIn: 86400 },
  },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  resolveUserFeatures: () => [],
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: async () => false,
  resolveOrgLineage: async (orgId: string) => ({ rootOrgId: orgId }),
  getParentOrgId: async () => undefined,
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

/** The permissions the (hand-written) Role a user holds carries. */
let heldRolePermissions: string[] = [];
const mockRoleFindOne = jest.fn<(...a: unknown[]) => unknown>();
const chain = (rows: () => unknown[]) => () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve(rows()) }) }) });

jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { updateOne: jest.fn(async () => ({})) },
  Organization: {
    findById: (id: string) => ({ select: () => ({ lean: () => Promise.resolve({ name: `org-${id}`, tier: 'team', parentOrgId: null, deletedAt: null }) }) }),
  },
  UserOrganization: {
    findOne: () => ({ lean: () => Promise.resolve({ role: 'member' }) }),
    find: () => ({ sort: () => ({ lean: () => Promise.resolve([]) }) }),
  },
  Role: {
    find: chain(() => [{ _id: 'r1', name: 'Ecosystem Manager', grantsRole: 'member', permissions: heldRolePermissions }]),
    findOne: (...a: unknown[]) => mockRoleFindOne(...a),
  },
  RoleAssignment: { find: chain(() => [{ roleId: 'r1' }]) },
}));

const { signInAuth, signServiceAccountToken } = await import('../src/services/session/access-tokens.js');
const { issueTokens } = await import('../src/services/session/refresh-sessions.js');
const { sanitizePermissions, assertActorMayAssignRole, assertSystemOrgOnlyRoleInSystemOrg } = await import('../src/services/role-authority.js');
const { assertMappableRoleSet } = await import('../src/services/mapped-roles.js');
const { ensureBaselineRole } = await import('../src/services/roles-service.js');
const {
  RL_PERMISSION_NOT_ASSIGNABLE, RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN, RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG,
} = await import('../src/services/roles-errors.js');
const { IGM_FORBIDDEN_GRANT } = await import('../src/services/idp-mapping-errors.js');
const { installTestSigningKeys } = await import('./helpers/signing.js');
installTestSigningKeys();

const EM_BUNDLE = ['plugins:read', 'plugins:moderate', 'publishers:verify', 'messages:read', 'observability:read'];
const superadmin = { isSuperAdmin: true, isOrgAdmin: true, permissions: [] as string[] };
const orgAdmin = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };

function user(isSuperAdmin = false) {
  return {
    _id: { toString: () => 'user-1' },
    username: 'u',
    email: 'u@example.com',
    isEmailVerified: true,
    tokenVersion: 1,
    ...(isSuperAdmin ? { isSuperAdmin: true } : {}),
  } as unknown as Parameters<typeof issueTokens>[0];
}
const claims = async (orgId: string, isSuperAdmin = false): Promise<string[]> => {
  const { accessToken } = await issueTokens(user(isSuperAdmin), orgId, { kind: 'interactive', auth: signInAuth('pwd') });
  return (jwt.decode(accessToken) as { permissions: string[] }).permissions;
};

beforeEach(() => {
  heldRolePermissions = [...EM_BUNDLE];
  mockRoleFindOne.mockReset();
});

describe('path: custom Role (sanitizePermissions)', () => {
  it.each(ECOSYSTEM)('refuses %s in any custom Role — for an org admin and for a superadmin alike', (p) => {
    expect(() => sanitizePermissions([p], { permissions: [...EM_BUNDLE], isSuperAdmin: false })).toThrow(RL_PERMISSION_NOT_ASSIGNABLE);
    expect(() => sanitizePermissions(['plugins:read', p], { permissions: [], isSuperAdmin: true })).toThrow(RL_PERMISSION_NOT_ASSIGNABLE);
  });
});

describe('path: assignment', () => {
  it('only a superadmin may assign or unassign a Role carrying the permissions — an org admin is refused', () => {
    expect(() => assertActorMayAssignRole(EM_BUNDLE, orgAdmin)).toThrow(RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN);
    expect(() => assertActorMayAssignRole(EM_BUNDLE, { isSuperAdmin: false, isOrgAdmin: false, permissions: [...EM_BUNDLE, 'roles:manage'] }))
      .toThrow(RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN);
    expect(() => assertActorMayAssignRole(EM_BUNDLE, superadmin)).not.toThrow();
  });

  it('such a Role may be held only inside the system org — whoever the actor is', () => {
    expect(() => assertSystemOrgOnlyRoleInSystemOrg(EM_BUNDLE, TENANT)).toThrow(RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG);
    expect(() => assertSystemOrgOnlyRoleInSystemOrg(EM_BUNDLE, SYSTEM)).not.toThrow();
    expect(() => assertSystemOrgOnlyRoleInSystemOrg(['plugins:read'], TENANT)).not.toThrow();
  });
});

describe('path: invitation (Member floor)', () => {
  it('the Member floor an invitee gets never matches the Ecosystem Manager (which shares grantsRole member)', async () => {
    mockRoleFindOne.mockReturnValue({ session: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) });
    await ensureBaselineRole('user-1', SYSTEM);
    expect(mockRoleFindOne).toHaveBeenCalledWith(expect.objectContaining({ grantsRole: 'member', system: true, seedBundle: null }));
  });
});

describe('path: IdP group mapping', () => {
  it('refuses to map a directory group to a Role carrying the permissions, even for a superadmin', async () => {
    await expect(assertMappableRoleSet(SYSTEM, ['r1'], superadmin)).rejects.toThrow(IGM_FORBIDDEN_GRANT);
  });
});

describe('path: token issuance', () => {
  it('a tenant-org token never claims them, even when a stray Role there carries them', async () => {
    const perms = await claims(TENANT);
    expect(perms).toContain('plugins:read');
    for (const p of ECOSYSTEM) expect(perms).not.toContain(p);
  });

  it('a system-org token for an Ecosystem Manager carries them', async () => {
    const perms = await claims(SYSTEM);
    for (const p of ECOSYSTEM) expect(perms).toContain(p);
  });

  it('a superadmin\'s implicit-all is confined too: tenant org without, system org with', async () => {
    heldRolePermissions = [];
    for (const p of ECOSYSTEM) expect(await claims(TENANT, true)).not.toContain(p);
    for (const p of ECOSYSTEM) expect(await claims(SYSTEM, true)).toContain(p);
  });

  it('a tenant service-account token never claims them either', async () => {
    const token = await signServiceAccountToken({
      id: 'sa-1', name: 'ci', organizationId: TENANT, rolePermissions: [...EM_BUNDLE], role: 'member', isSuperAdmin: false,
    }, 'key-1');
    const perms = (jwt.decode(token) as { permissions: string[] }).permissions;
    expect(perms).toContain('plugins:read');
    for (const p of ECOSYSTEM) expect(perms).not.toContain(p);
  });
});
