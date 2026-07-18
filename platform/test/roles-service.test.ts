// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the first-class Roles RBAC layer:
 *   - seedDefaultRoles: default Roles on org create (+ Superadmins for the
 *     system org) and the creator's Role assignment / isSuperAdmin flag.
 *   - recomputeUserOrgRole: derive the cached UserOrganization.role from Role
 *     assignment (preserving `owner`; superadmin grants AND revokes isSuperAdmin
 *     within an org that defines a Superadmins Role); bump tokenVersion on a
 *     genuine privilege change so it takes effect immediately (G1).
 *   - add/removeUserFromRole: management entrypoints, error paths, and the
 *     lockout guards (G2 self-removal, G3 last privileged member).
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockGroupCreate = jest.fn();
const mockGroupFind = jest.fn();
const mockGroupFindOne = jest.fn();
const mockGroupExists = jest.fn();
const mockGmCreate = jest.fn();
const mockGmFind = jest.fn();
const mockGmUpdateOne = jest.fn();
const mockGmDeleteOne = jest.fn();
const mockGmExists = jest.fn();
const mockGmCount = jest.fn();
const mockUoFindOne = jest.fn();
const mockUserUpdateOne = jest.fn();
const mockUserUpdateMany = jest.fn();
const mockUserFindById = jest.fn();
const mockUserFindOne = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('mongoose', () => ({
  default: { Types: { ObjectId: class {} } },
  Types: { ObjectId: class {} },
}));

// toOrgId is identity in tests — we assert on the raw orgId strings.
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));

// Run the transaction body inline with a fake session — unit tests have no
// live Mongo connection, so we bypass startSession/withTransaction and just
// invoke the callback. The session is threaded into the write + recompute.
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: {
    create: (...a: unknown[]) => mockGroupCreate(...a),
    find: (...a: unknown[]) => mockGroupFind(...a),
    findOne: (...a: unknown[]) => mockGroupFindOne(...a),
    exists: (...a: unknown[]) => mockGroupExists(...a),
  },
  RoleAssignment: {
    create: (...a: unknown[]) => mockGmCreate(...a),
    find: (...a: unknown[]) => mockGmFind(...a),
    updateOne: (...a: unknown[]) => mockGmUpdateOne(...a),
    deleteOne: (...a: unknown[]) => mockGmDeleteOne(...a),
    exists: (...a: unknown[]) => mockGmExists(...a),
    countDocuments: (...a: unknown[]) => mockGmCount(...a),
  },
  User: {
    updateOne: (...a: unknown[]) => mockUserUpdateOne(...a),
    updateMany: (...a: unknown[]) => mockUserUpdateMany(...a),
    findById: (...a: unknown[]) => mockUserFindById(...a),
    findOne: (...a: unknown[]) => mockUserFindOne(...a),
  },
  UserOrganization: { findOne: (...a: unknown[]) => mockUoFindOne(...a) },
}));

const {
  seedDefaultRoles, recomputeUserOrgRole, ensureBaselineRole, getUserRolePermissions,
  addUserToRole, removeUserFromRole, updateRole,
  grantPlatformAdmin, revokePlatformAdmin,
  RL_ROLE_NOT_FOUND, RL_USER_NOT_FOUND, RL_NOT_ORG_MEMBER,
  RL_CANNOT_REMOVE_SELF, RL_LAST_PRIVILEGED_MEMBER, RL_REQUIRES_SUPERADMIN,
  RL_SUPERADMIN_ROLE_MISSING,
} = await import('../src/services/roles-service.js');

// The single-source resolver, from the (mocked) api-core — faithful: superadmin
// ⇒ all, else exactly the union of the passed Role permissions (no baseline).
const { resolveUserPermissions } = await import('@pipeline-builder/api-core') as unknown as {
  resolveUserPermissions: (perms?: readonly string[] | null, isSuperAdmin?: boolean) => string[];
};

// Role.create echoes back the docs with a name-derived _id.
const echoCreate = () => mockGroupCreate.mockImplementation((docs: Array<{ name: string; grantsRole: string }>) =>
  Promise.resolve(docs.map((d) => ({ _id: `g-${d.name}`, name: d.name, grantsRole: d.grantsRole }))));
// find(...).session(...).select(...).lean()
const findReturns = (mock: jest.Mock, rows: unknown[]) =>
  mock.mockReturnValue({ session: () => ({ select: () => ({ lean: () => Promise.resolve(rows) }) }) });
// Role.exists(...).session(...) resolves to a truthy/null sentinel.
const orgHasSuperadminRole = (has: boolean) =>
  mockGroupExists.mockReturnValue({ session: () => Promise.resolve(has ? { _id: 'sa' } : null) });
// User.findById(...).select('+isSuperAdmin').session(...) — recompute's read of the current flag.
const currentIsSuperAdmin = (value: boolean) =>
  mockUserFindById.mockReturnValue({ select: () => ({ session: () => Promise.resolve({ isSuperAdmin: value }) }) });

beforeEach(() => {
  jest.clearAllMocks();
  echoCreate();
  mockGmCreate.mockResolvedValue([]);
  mockGmDeleteOne.mockResolvedValue({});
  mockUserUpdateOne.mockResolvedValue({});
  orgHasSuperadminRole(false); // default: ordinary org, isSuperAdmin untouched
});

describe('seedDefaultRoles', () => {
  it('seeds Admin + Member for a normal org; creator joins Admin only', async () => {
    await seedDefaultRoles('org-1', 'u1', {});

    const seeded = mockGroupCreate.mock.calls[0][0] as Array<{ name: string; grantsRole: string; system: boolean }>;
    expect(seeded.map((g) => g.name)).toEqual(['Admin', 'Member']);
    expect(seeded.every((g) => g.system)).toBe(true);

    const assignments = mockGmCreate.mock.calls[0][0] as Array<{ userId: string; roleId: string }>;
    expect(assignments.map((m) => m.roleId)).toEqual(['g-Admin']);
    expect(mockUserUpdateOne).not.toHaveBeenCalled(); // no isSuperAdmin for a normal org
  });

  it('seeds each built-in Role WITH its own permission bundle (self-describing Roles)', async () => {
    await seedDefaultRoles('org-1', 'u1', {});

    const seeded = mockGroupCreate.mock.calls[0][0] as Array<{ name: string; grantsRole: string; permissions: string[] }>;
    const admins = seeded.find((g) => g.name === 'Admin')!;
    const devs = seeded.find((g) => g.name === 'Member')!;

    // Admin → the full admin bundle (all permissions).
    expect(admins.permissions).toContain('roles:manage');
    expect(admins.permissions).toContain('org:settings');
    expect(admins.permissions).toContain('members:manage');
    // Member → the read-heavy member bundle: no admin-only grants.
    expect(devs.permissions).toContain('pipelines:write');
    expect(devs.permissions).toContain('compliance:read');
    expect(devs.permissions).not.toContain('roles:manage');
    expect(devs.permissions).not.toContain('org:settings');
    expect(devs.permissions.length).toBeLessThan(admins.permissions.length);
  });

  it('seeds the Super Admin Role with the admin bundle (system org)', async () => {
    await seedDefaultRoles('000000000000000000000001', 'u1', { isSystemOrg: true });

    const seeded = mockGroupCreate.mock.calls[0][0] as Array<{ name: string; grantsRole: string; permissions: string[] }>;
    const superadmins = seeded.find((g) => g.name === 'Super Admin')!;
    expect(superadmins.permissions).toContain('org:settings');
    expect(superadmins.permissions).toContain('roles:manage');
  });

  it('seeds Super Admin for the system org; creator joins Super Admin + Admin and is flagged isSuperAdmin', async () => {
    await seedDefaultRoles('000000000000000000000001', 'u1', { isSystemOrg: true });

    const seeded = mockGroupCreate.mock.calls[0][0] as Array<{ name: string }>;
    expect(seeded.map((g) => g.name)).toEqual(['Super Admin', 'Admin', 'Member']);

    const assignments = mockGmCreate.mock.calls[0][0] as Array<{ roleId: string }>;
    expect(assignments.map((m) => m.roleId)).toEqual(['g-Super Admin', 'g-Admin']);
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { isSuperAdmin: true } }, expect.anything());
  });
});

describe('recomputeUserOrgRole', () => {
  it('sets role=admin when the user holds an admin-granting Role, and bumps tokenVersion (G1)', async () => {
    findReturns(mockGmFind, [{ roleId: 'gA' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'admin' }]);
    const uo = { role: 'member', save: jest.fn().mockResolvedValue(undefined) };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', 'org-1');

    expect(uo.role).toBe('admin');
    expect(uo.save).toHaveBeenCalled();
    // G1: the role flip must invalidate existing tokens.
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $inc: { tokenVersion: 1 } }, expect.anything());
  });

  it('preserves owner regardless of Roles and does NOT bump tokenVersion', async () => {
    findReturns(mockGmFind, [{ roleId: 'gD' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);
    const uo = { role: 'owner', save: jest.fn() };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', 'org-1');

    expect(uo.role).toBe('owner');
    expect(uo.save).not.toHaveBeenCalled();
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('does NOT bump tokenVersion when nothing changes (member stays member)', async () => {
    findReturns(mockGmFind, [{ roleId: 'gD' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);
    const uo = { role: 'member', save: jest.fn() };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', 'org-1');

    expect(uo.save).not.toHaveBeenCalled();
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('a superadmin Role flags isSuperAdmin (genuine flip), yields admin role, and bumps tokenVersion', async () => {
    findReturns(mockGmFind, [{ roleId: 'gS' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'superadmin' }]);
    orgHasSuperadminRole(true);
    currentIsSuperAdmin(false); // not a superadmin yet → flip to true
    const uo = { role: 'member', save: jest.fn().mockResolvedValue(undefined) };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', '000000000000000000000001');

    expect(uo.role).toBe('admin');
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { isSuperAdmin: true } }, expect.anything());
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $inc: { tokenVersion: 1 } }, expect.anything());
  });

  it('DEMOTES isSuperAdmin when no longer in a superadmin Role (system org) and bumps tokenVersion', async () => {
    findReturns(mockGmFind, [{ roleId: 'gD' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);
    orgHasSuperadminRole(true);
    currentIsSuperAdmin(true); // was a superadmin → flip to false
    const uo = { role: 'admin', save: jest.fn().mockResolvedValue(undefined) };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', '000000000000000000000001');

    expect(uo.role).toBe('member');
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { isSuperAdmin: false } }, expect.anything());
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $inc: { tokenVersion: 1 } }, expect.anything());
  });

  it('does not write isSuperAdmin when the flag is already correct (no spurious tokenVersion bump)', async () => {
    findReturns(mockGmFind, [{ roleId: 'gD' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);
    orgHasSuperadminRole(true);
    currentIsSuperAdmin(false); // already false, target false → no change
    const uo = { role: 'member', save: jest.fn() };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', '000000000000000000000001');

    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('never touches isSuperAdmin in an org with no superadmin Role', async () => {
    findReturns(mockGmFind, [{ roleId: 'gA' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'admin' }]);
    orgHasSuperadminRole(false);
    const uo = { role: 'member', save: jest.fn().mockResolvedValue(undefined) };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', 'org-1');

    expect(mockUserFindById).not.toHaveBeenCalled(); // no read of the flag at all
    // tokenVersion bump (role changed) is fine, but no isSuperAdmin write.
    const setCalls = mockUserUpdateOne.mock.calls.filter((c) => (c[1] as { $set?: { isSuperAdmin?: unknown } })?.$set?.isSuperAdmin !== undefined);
    expect(setCalls).toHaveLength(0);
  });
});

describe('ensureBaselineRole', () => {
  // Role.findOne({ grantsRole: 'member', system: true })…select('_id').lean() → the
  // org's built-in Member Role (located by grantsRole, not display name).
  const memberRoleFound = (id: string | null) =>
    mockGroupFindOne.mockReturnValue({ session: () => ({ select: () => ({ lean: () => Promise.resolve(id ? { _id: id } : null) }) }) });

  it('upserts the built-in Member Role assignment and recomputes the cached role', async () => {
    memberRoleFound('g-Member');
    mockGmUpdateOne.mockResolvedValue({});
    // recompute: user now holds the Member Role → role stays member, no bump.
    findReturns(mockGmFind, [{ roleId: 'g-Member' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);
    mockUoFindOne.mockReturnValue({ session: () => ({ role: 'member', save: jest.fn() }) });

    await ensureBaselineRole('u1', 'org-1');

    expect(mockGmUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', roleId: 'g-Member' },
      { $setOnInsert: { userId: 'u1', roleId: 'g-Member', organizationId: 'org-1' } },
      { upsert: true, session: undefined },
    );
    // Idempotent + member floor: no privilege flip, so no tokenVersion bump.
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('no-ops (no upsert) when the org has no built-in Member Role', async () => {
    memberRoleFound(null);
    await ensureBaselineRole('u1', 'org-1');
    expect(mockGmUpdateOne).not.toHaveBeenCalled();
  });
});

describe('single-source permission resolution (behavior change)', () => {
  // getUserRolePermissions: RoleAssignment.find(...).session().select().lean()
  // then Role.find(...).session().select().lean() with the Roles' permissions.
  const userInRolesWithPerms = (roleIds: string[], perms: string[][]) => {
    findReturns(mockGmFind, roleIds.map((roleId) => ({ roleId })));
    findReturns(mockGroupFind, perms.map((permissions) => ({ permissions })));
  };

  it('(b) a plain member (Developers Role) resolves to exactly the member bundle', async () => {
    userInRolesWithPerms(['g-Developers'], [[
      'pipelines:read', 'pipelines:write', 'plugins:read', 'plugins:write',
      'compliance:read', 'dashboards:read', 'messages:read', 'messages:write',
      'billing:read', 'quotas:read', 'registry:read',
    ]]);

    const perms = await getUserRolePermissions('u1', 'org-1');
    const effective = resolveUserPermissions(perms, false);

    expect(effective).toContain('pipelines:write');
    expect(effective).toContain('compliance:read');
    // Member bundle grants no admin-only capabilities.
    expect(effective).not.toContain('roles:manage');
    expect(effective).not.toContain('org:settings');
    expect(effective).not.toContain('members:manage');
  });

  it('(c) an admin (Administrators Role) resolves to ALL permissions', async () => {
    userInRolesWithPerms(['g-Administrators'], [[
      'pipelines:read', 'pipelines:write', 'plugins:read', 'plugins:write',
      'compliance:read', 'compliance:write', 'members:manage', 'roles:manage',
      'invitations:manage', 'dashboards:read', 'dashboards:write',
      'observability:read', 'observability:write', 'reports:read',
      'messages:read', 'messages:write', 'billing:read', 'billing:manage',
      'quotas:read', 'registry:read', 'registry:write', 'org:settings',
    ]]);

    const effective = resolveUserPermissions(await getUserRolePermissions('u1', 'org-1'), false);

    expect(effective).toContain('roles:manage');
    expect(effective).toContain('org:settings');
    expect(effective).toContain('members:manage');
    expect(effective).toContain('billing:manage');
  });

  it('(d) a member in ONLY a narrow custom Role resolves to EXACTLY that Role — no hidden member baseline', async () => {
    // The key behavior change: no role-derived baseline is unioned in. A user
    // whose only Role grants `pipelines:read` gets that and nothing else.
    userInRolesWithPerms(['g-custom'], [['pipelines:read']]);

    const effective = resolveUserPermissions(await getUserRolePermissions('u1', 'org-1'), false);

    expect(effective).toEqual(['pipelines:read']);
    // Would-be member-baseline grants must NOT leak in.
    expect(effective).not.toContain('pipelines:write');
    expect(effective).not.toContain('plugins:read');
    expect(effective).not.toContain('messages:read');
  });
});

describe('addUserToRole error paths', () => {
  it('throws RL_ROLE_NOT_FOUND when the Role is missing', async () => {
    mockGroupFindOne.mockResolvedValue(null);
    await expect(addUserToRole('org-1', 'gX', { userId: 'u1' }, false)).rejects.toThrow(RL_ROLE_NOT_FOUND);
  });

  it('throws RL_USER_NOT_FOUND when the user does not exist', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gA' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve(null) });
    await expect(addUserToRole('org-1', 'gA', { userId: 'nope' }, false)).rejects.toThrow(RL_USER_NOT_FOUND);
  });

  it('throws RL_NOT_ORG_MEMBER when the user is not in the org', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gA' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'u1' }) });
    mockUoFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    await expect(addUserToRole('org-1', 'gA', { userId: 'u1' }, false)).rejects.toThrow(RL_NOT_ORG_MEMBER);
  });

  it('upserts the assignment and recomputes the role on success', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gA' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'u1' }) });
    mockUoFindOne
      .mockReturnValueOnce({ select: () => Promise.resolve({ _id: 'm1' }) }) // org-membership check
      .mockReturnValue({ session: () => ({ role: 'member', save: jest.fn().mockResolvedValue(undefined) }) }); // recompute
    mockGmUpdateOne.mockResolvedValue({});
    findReturns(mockGmFind, [{ roleId: 'gA' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'admin' }]);

    const res = await addUserToRole('org-1', 'gA', { userId: 'u1' }, false);

    expect(res).toEqual({ userId: 'u1' });
    expect(mockGmUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', roleId: 'gA' },
      { $setOnInsert: { userId: 'u1', roleId: 'gA', organizationId: 'org-1' } },
      { upsert: true, session: expect.anything() },
    );
  });

  it('SECURITY: a non-superadmin cannot add a member to a superadmin-granting Role', async () => {
    // The system-org Superadmins Role. A mere org admin (actorIsSuperAdmin=false)
    // must be rejected BEFORE any assignment write — otherwise recomputeUserOrgRole
    // would mint a platform superadmin (privilege escalation).
    mockGroupFindOne.mockResolvedValue({ _id: 'gS', grantsRole: 'superadmin' });

    await expect(addUserToRole('000000000000000000000001', 'gS', { userId: 'u1' }, false))
      .rejects.toThrow(RL_REQUIRES_SUPERADMIN);
    expect(mockGmUpdateOne).not.toHaveBeenCalled();
  });

  it('allows a platform superadmin to add a member to a superadmin-granting Role', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gS', grantsRole: 'superadmin' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'u1' }) });
    mockUoFindOne
      .mockReturnValueOnce({ select: () => Promise.resolve({ _id: 'm1' }) })
      .mockReturnValue({ session: () => ({ role: 'member', save: jest.fn().mockResolvedValue(undefined) }) });
    mockGmUpdateOne.mockResolvedValue({});
    findReturns(mockGmFind, [{ roleId: 'gS' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'superadmin' }]);

    const res = await addUserToRole('000000000000000000000001', 'gS', { userId: 'u1' }, true);

    expect(res).toEqual({ userId: 'u1' });
    expect(mockGmUpdateOne).toHaveBeenCalled();
  });
});

describe('removeUserFromRole', () => {
  it('throws RL_ROLE_NOT_FOUND when the Role is missing', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    await expect(removeUserFromRole('org-1', 'gX', 'u1')).rejects.toThrow(RL_ROLE_NOT_FOUND);
  });

  it('deletes the assignment and recomputes for a member-only Role (no guards)', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gD', grantsRole: 'member', name: 'Member' }) });
    findReturns(mockGmFind, []);
    mockUoFindOne.mockReturnValue({ session: () => ({ role: 'admin', save: jest.fn().mockResolvedValue(undefined) }) });

    await removeUserFromRole('org-1', 'gD', 'u1');

    expect(mockGmDeleteOne).toHaveBeenCalledWith({ userId: 'u1', roleId: 'gD' }, { session: expect.anything() });
    expect(mockGmExists).not.toHaveBeenCalled(); // member-only → guards skipped
  });

  it('G2: blocks removing yourself from a privilege-granting Role', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gA', grantsRole: 'admin', name: 'Admin' }) });
    mockGmExists.mockResolvedValue({ _id: 'm1' }); // the actor IS a member

    await expect(removeUserFromRole('org-1', 'gA', 'u1', { actorUserId: 'u1' }))
      .rejects.toThrow(RL_CANNOT_REMOVE_SELF);
    expect(mockGmDeleteOne).not.toHaveBeenCalled();
  });

  it('G3: blocks removing the last member of a privilege-granting Role', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gA', grantsRole: 'admin', name: 'Admin' }) });
    mockGmExists.mockResolvedValue({ _id: 'm1' });
    mockGmCount.mockResolvedValue(1); // this user is the only one

    await expect(removeUserFromRole('org-1', 'gA', 'victim', { actorUserId: 'owner-not-in-role' }))
      .rejects.toThrow(RL_LAST_PRIVILEGED_MEMBER);
    expect(mockGmDeleteOne).not.toHaveBeenCalled();
  });

  it('allows removing a non-last member of a privilege-granting Role', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gA', grantsRole: 'admin', name: 'Admin' }) });
    mockGmExists.mockResolvedValue({ _id: 'm1' });
    mockGmCount.mockResolvedValue(2); // another admin remains
    findReturns(mockGmFind, []);
    mockUoFindOne.mockReturnValue({ session: () => ({ role: 'admin', save: jest.fn().mockResolvedValue(undefined) }) });

    await removeUserFromRole('org-1', 'gA', 'victim', { actorUserId: 'other-admin' });

    expect(mockGmDeleteOne).toHaveBeenCalledWith({ userId: 'victim', roleId: 'gA' }, { session: expect.anything() });
  });

  it('SECURITY: a non-superadmin cannot remove a member of a superadmin-granting Role', async () => {
    // Reverse of the escalation: stops a system-org admin from stripping
    // isSuperAdmin off a real superadmin via the recompute.
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gS', grantsRole: 'superadmin', name: 'Super Admin' }) });

    await expect(removeUserFromRole('000000000000000000000001', 'gS', 'victim', { actorUserId: 'admin', actorIsSuperAdmin: false }))
      .rejects.toThrow(RL_REQUIRES_SUPERADMIN);
    expect(mockGmDeleteOne).not.toHaveBeenCalled();
  });
});

describe('updateRole (atomic permission edit + member tokenVersion bump)', () => {
  /** A custom (non-system) Role doc with a spyable `.save()`. */
  const roleDoc = () => ({
    _id: 'gCustom',
    name: 'Deployers',
    system: false,
    permissions: ['pipelines:read'],
    save: jest.fn().mockResolvedValue(undefined),
  });

  it('wraps role.save + the members tokenVersion bump in ONE transaction (session threaded)', async () => {
    const doc = roleDoc();
    mockGroupFindOne.mockResolvedValue(doc);
    // RoleAssignment.find({ roleId }).session().select('userId').lean() → members.
    findReturns(mockGmFind, [{ userId: 'm1' }, { userId: 'm2' }]);

    await updateRole('org-1', 'gCustom', { permissions: ['pipelines:write'] });

    // The Role edit is persisted WITH the transaction session ...
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(doc.save).toHaveBeenCalledWith({ session: expect.anything() });
    // ... and the members' access tokens are invalidated in the SAME session,
    // so the new grants can't diverge from the persisted permissions.
    expect(mockUserUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['m1', 'm2'] } },
      { $inc: { tokenVersion: 1 } },
      { session: expect.anything() },
    );
  });

  it('does NOT bump tokenVersion when permissions are unchanged (name-only edit)', async () => {
    const doc = roleDoc();
    mockGroupFindOne.mockResolvedValue(doc);

    await updateRole('org-1', 'gCustom', { description: 'renamed' });

    expect(doc.save).toHaveBeenCalledWith({ session: expect.anything() });
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });
});

describe('grantPlatformAdmin / revokePlatformAdmin (single-source: Super Admin Role is authoritative)', () => {
  const SYS = '000000000000000000000001'; // SYSTEM_ORG_ID (matches the api-core mock)

  // Role.findOne(...superadmin...).session().select('_id').lean() → the system Super Admin Role.
  const superAdminRoleFound = (id: string | null) =>
    mockGroupFindOne.mockReturnValue({ session: () => ({ select: () => ({ lean: () => Promise.resolve(id ? { _id: id } : null) }) }) });
  // User.findById(...).select('+isSuperAdmin').session() — awaited by recompute AND .lean()'d by grant/revoke's before-read.
  const userIsSuperAdmin = (value: boolean) => mockUserFindById.mockReturnValue({
    select: () => ({
      session: () => {
        const p = Promise.resolve({ isSuperAdmin: value }) as Promise<{ isSuperAdmin: boolean }> & { lean?: () => Promise<{ isSuperAdmin: boolean }> };
        p.lean = () => Promise.resolve({ isSuperAdmin: value });
        return p;
      },
    }),
  });

  it('grant: assigns the system Super Admin Role, recompute flips the flag + bumps tokenVersion, drops refresh', async () => {
    superAdminRoleFound('sa-role');
    mockGmUpdateOne.mockResolvedValue({});
    userIsSuperAdmin(false); // before + recompute current: not yet superadmin
    findReturns(mockGmFind, [{ roleId: 'sa-role' }]); // recompute: user now holds the Super Admin Role
    findReturns(mockGroupFind, [{ grantsRole: 'superadmin' }]);
    mockUoFindOne.mockReturnValue({ session: () => null }); // no UserOrganization membership needed for the flag
    orgHasSuperadminRole(true); // system org defines a superadmin Role
    mockUserUpdateOne.mockResolvedValue({});

    const result = await grantPlatformAdmin('u1');

    expect(mockGmUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', roleId: 'sa-role' },
      { $setOnInsert: { userId: 'u1', roleId: 'sa-role', organizationId: SYS } },
      expect.objectContaining({ upsert: true }),
    );
    // recompute flips isSuperAdmin false→true and bumps tokenVersion
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { isSuperAdmin: true } }, expect.anything());
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $inc: { tokenVersion: 1 } }, expect.anything());
    // a real change drops the refresh token
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $unset: { refreshToken: '' } }, expect.anything());
    expect(result).toEqual({ changed: true });
  });

  it('grant: idempotent (already superadmin) → no refresh drop, changed:false', async () => {
    superAdminRoleFound('sa-role');
    mockGmUpdateOne.mockResolvedValue({});
    userIsSuperAdmin(true); // already superadmin
    findReturns(mockGmFind, [{ roleId: 'sa-role' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'superadmin' }]);
    mockUoFindOne.mockReturnValue({ session: () => null });
    orgHasSuperadminRole(true);
    mockUserUpdateOne.mockResolvedValue({});

    const result = await grantPlatformAdmin('u1');

    expect(result).toEqual({ changed: false });
    // no flip (current already true) → no tokenVersion bump, no refresh drop
    expect(mockUserUpdateOne).not.toHaveBeenCalledWith({ _id: 'u1' }, { $unset: { refreshToken: '' } }, expect.anything());
    expect(mockUserUpdateOne).not.toHaveBeenCalledWith({ _id: 'u1' }, { $inc: { tokenVersion: 1 } }, expect.anything());
  });

  it('revoke: removes the Role, recompute clears the flag, drops refresh', async () => {
    superAdminRoleFound('sa-role');
    mockGmDeleteOne.mockResolvedValue({});
    userIsSuperAdmin(true); // was superadmin
    findReturns(mockGmFind, []); // recompute: no superadmin assignment now
    findReturns(mockGroupFind, []);
    mockUoFindOne.mockReturnValue({ session: () => null });
    orgHasSuperadminRole(true);
    mockUserUpdateOne.mockResolvedValue({});

    const result = await revokePlatformAdmin('u1');

    expect(mockGmDeleteOne).toHaveBeenCalledWith({ userId: 'u1', roleId: 'sa-role' }, expect.objectContaining({ session: expect.anything() }));
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { isSuperAdmin: false } }, expect.anything());
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $unset: { refreshToken: '' } }, expect.anything());
    expect(result).toEqual({ changed: true });
  });

  it('throws RL_SUPERADMIN_ROLE_MISSING when the system org has no Super Admin Role', async () => {
    superAdminRoleFound(null);
    await expect(grantPlatformAdmin('u1')).rejects.toThrow(RL_SUPERADMIN_ROLE_MISSING);
  });
});
