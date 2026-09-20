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
const mockGroupCount = jest.fn();
const mockGmCreate = jest.fn();
const mockGmFind = jest.fn();
const mockGmUpdateOne = jest.fn();
const mockGmDeleteOne = jest.fn();
const mockGmExists = jest.fn();
const mockGmCount = jest.fn();
const mockGmAggregate = jest.fn();
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
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

// Run the transaction body inline with a fake session — unit tests have no
// live Mongo connection, so we bypass startSession/withTransaction and just
// invoke the callback. The session is threaded into the write + recompute.
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Role: {
    create: (...a: unknown[]) => mockGroupCreate(...a),
    find: (...a: unknown[]) => mockGroupFind(...a),
    findOne: (...a: unknown[]) => mockGroupFindOne(...a),
    exists: (...a: unknown[]) => mockGroupExists(...a),
    countDocuments: (...a: unknown[]) => mockGroupCount(...a),
  },
  RoleAssignment: {
    create: (...a: unknown[]) => mockGmCreate(...a),
    find: (...a: unknown[]) => mockGmFind(...a),
    updateOne: (...a: unknown[]) => mockGmUpdateOne(...a),
    deleteOne: (...a: unknown[]) => mockGmDeleteOne(...a),
    exists: (...a: unknown[]) => mockGmExists(...a),
    countDocuments: (...a: unknown[]) => mockGmCount(...a),
    aggregate: (...a: unknown[]) => mockGmAggregate(...a),
  },
  User: {
    updateOne: (...a: unknown[]) => mockUserUpdateOne(...a),
    updateMany: (...a: unknown[]) => mockUserUpdateMany(...a),
    findById: (...a: unknown[]) => mockUserFindById(...a),
    findOne: (...a: unknown[]) => mockUserFindOne(...a),
  },
  UserOrganization: { findOne: (...a: unknown[]) => mockUoFindOne(...a) },
}));

const { seedDefaultRoles, recomputeUserOrgRole, ensureBaselineRole, assertActorMayAssignBuiltinAdmin } = await import('../src/services/roles-service.js');
const { listRolesWithMembers, getUserRolePermissions, addUserToRole, removeUserFromRole, updateRole } = await import('../src/services/role-crud.js');
const { grantPlatformAdmin, revokePlatformAdmin } = await import('../src/services/platform-admin-roles.js');
const { RL_ROLE_NOT_FOUND, RL_USER_NOT_FOUND, RL_NOT_ORG_MEMBER, RL_CANNOT_REMOVE_SELF, RL_LAST_PRIVILEGED_MEMBER, RL_REQUIRES_SUPERADMIN, RL_SUPERADMIN_ROLE_MISSING, RL_ASSIGN_EXCEEDS_CEILING } = await import('../src/services/roles-errors.js');

// Actor contexts for Role ASSIGNMENT (add/remove member). The 4th arg to
// addUserToRole is now the actor context, not a bare boolean: superadmin and
// org admin/owner bypass the permission ceiling; a non-admin `roles:manage`
// delegate is bound by it.
const superAdminActor = { isSuperAdmin: true, isOrgAdmin: false, permissions: [] as readonly string[] };
const orgAdminActor = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as readonly string[] };
/** A delegate holding only `roles:manage` (+ member-ish reads) — bound by the ceiling. */
const delegateActor = (permissions: readonly string[]) => ({ isSuperAdmin: false, isOrgAdmin: false, permissions });

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
/** Query chain resolving to `rows` whatever order `.select()` / `.session()` come in. */
const anyOrderQuery = (rows: unknown) => {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.session = () => q;
  q.lean = () => Promise.resolve(rows);
  q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, ko);
  return q;
};
/** The last-privileged-member guard's reads: the user's assignment to the Role,
 *  the Role being privileged, and its member count. */
const guardSees = (roleId: string, members: number) => {
  mockGmExists.mockReturnValue(anyOrderQuery({ _id: 'm1' }));
  mockGmFind.mockReturnValueOnce(anyOrderQuery([{ roleId }]));
  mockGroupFind.mockReturnValueOnce(anyOrderQuery([{ _id: roleId }]));
  mockGmAggregate.mockReturnValueOnce(anyOrderQuery([{ _id: roleId, members }]));
};
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
    await expect(addUserToRole('org-1', 'gX', { userId: 'u1' }, orgAdminActor)).rejects.toThrow(RL_ROLE_NOT_FOUND);
  });

  it('throws RL_USER_NOT_FOUND when the user does not exist', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gA' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve(null) });
    await expect(addUserToRole('org-1', 'gA', { userId: 'nope' }, orgAdminActor)).rejects.toThrow(RL_USER_NOT_FOUND);
  });

  it('throws RL_NOT_ORG_MEMBER when the user is not in the org', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gA' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'u1' }) });
    mockUoFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    await expect(addUserToRole('org-1', 'gA', { userId: 'u1' }, orgAdminActor)).rejects.toThrow(RL_NOT_ORG_MEMBER);
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

    const res = await addUserToRole('org-1', 'gA', { userId: 'u1' }, orgAdminActor);

    expect(res).toEqual({ userId: 'u1' });
    expect(mockGmUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', roleId: 'gA' },
      // `source: 'manual'` is $set, not $setOnInsert (3a): an explicit admin
      // grant takes over a row an IdP group sync may have created, so the sync
      // can no longer remove it.
      {
        $setOnInsert: { userId: 'u1', roleId: 'gA', organizationId: 'org-1' },
        $set: { source: 'manual' },
      },
      { upsert: true, session: expect.anything() },
    );
  });

  it('SECURITY: a non-superadmin cannot add a member to a superadmin-granting Role', async () => {
    // The system-org Superadmins Role. A mere org admin (actorIsSuperAdmin=false)
    // must be rejected BEFORE any assignment write — otherwise recomputeUserOrgRole
    // would mint a platform superadmin (privilege escalation).
    mockGroupFindOne.mockResolvedValue({ _id: 'gS', grantsRole: 'superadmin' });

    // Even an org admin (isOrgAdmin) can't assign a superadmin-granting Role.
    await expect(addUserToRole('000000000000000000000001', 'gS', { userId: 'u1' }, orgAdminActor))
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

    const res = await addUserToRole('000000000000000000000001', 'gS', { userId: 'u1' }, superAdminActor);

    expect(res).toEqual({ userId: 'u1' });
    expect(mockGmUpdateOne).toHaveBeenCalled();
  });
});

describe('addUserToRole permission ceiling (within-tenant escalation guard)', () => {
  // The built-in Admin Role carries the full ADMIN_PERMISSIONS bundle.
  const adminRole = () => mockGroupFindOne.mockResolvedValue({
    _id: 'gAdmin',
    grantsRole: 'admin',
    permissions: ['members:manage', 'roles:manage', 'org:settings', 'billing:manage'],
  });
  // Wire user-found + org-member + recompute so a permitted assignment succeeds.
  const wireSuccessfulAssign = () => {
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'target' }) });
    mockUoFindOne
      .mockReturnValueOnce({ select: () => Promise.resolve({ _id: 'm1' }) })
      .mockReturnValue({ session: () => ({ role: 'member', save: jest.fn().mockResolvedValue(undefined) }) });
    mockGmUpdateOne.mockResolvedValue({});
    findReturns(mockGmFind, [{ roleId: 'gAdmin' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'admin' }]);
  };

  it('SECURITY: a roles:manage delegate (not admin/owner) CANNOT assign the built-in Admin Role', async () => {
    adminRole();
    // Delegate holds only roles:manage — lacks members:manage/org:settings/billing:manage.
    await expect(addUserToRole('org-1', 'gAdmin', { userId: 'self' }, delegateActor(['roles:manage'])))
      .rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);
    // Refused BEFORE any assignment write — no self-escalation.
    expect(mockGmUpdateOne).not.toHaveBeenCalled();
  });

  it('SECURITY: a delegate cannot assign a role carrying even ONE permission they lack', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gX', grantsRole: 'member', permissions: ['pipelines:read', 'org:settings'] });
    await expect(addUserToRole('org-1', 'gX', { userId: 'self' }, delegateActor(['pipelines:read', 'roles:manage'])))
      .rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);
    expect(mockGmUpdateOne).not.toHaveBeenCalled();
  });

  it('allows a delegate to assign a role whose permissions are a SUBSET of their own', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gCustom', grantsRole: 'member', permissions: ['pipelines:read'] });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'target' }) });
    mockUoFindOne
      .mockReturnValueOnce({ select: () => Promise.resolve({ _id: 'm1' }) })
      .mockReturnValue({ session: () => ({ role: 'member', save: jest.fn().mockResolvedValue(undefined) }) });
    mockGmUpdateOne.mockResolvedValue({});
    findReturns(mockGmFind, [{ roleId: 'gCustom' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);

    // Delegate holds pipelines:read (⊇ the Role's {pipelines:read}) plus roles:manage.
    const res = await addUserToRole('org-1', 'gCustom', { userId: 'target' }, delegateActor(['pipelines:read', 'roles:manage']));

    expect(res).toEqual({ userId: 'target' });
    expect(mockGmUpdateOne).toHaveBeenCalled();
  });

  it('allows an org admin/owner to assign the built-in Admin Role', async () => {
    adminRole();
    wireSuccessfulAssign();
    const res = await addUserToRole('org-1', 'gAdmin', { userId: 'target' }, orgAdminActor);
    expect(res).toEqual({ userId: 'target' });
    expect(mockGmUpdateOne).toHaveBeenCalled();
  });

  it('allows a platform superadmin to assign the built-in Admin Role', async () => {
    adminRole();
    wireSuccessfulAssign();
    const res = await addUserToRole('org-1', 'gAdmin', { userId: 'target' }, superAdminActor);
    expect(res).toEqual({ userId: 'target' });
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
    mockGmExists.mockReturnValue(anyOrderQuery({ _id: 'm1' })); // the actor IS a member

    await expect(removeUserFromRole('org-1', 'gA', 'u1', { actorUserId: 'u1' }))
      .rejects.toThrow(RL_CANNOT_REMOVE_SELF);
    expect(mockGmDeleteOne).not.toHaveBeenCalled();
  });

  it('G3: blocks removing the last member of a privilege-granting Role', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gA', grantsRole: 'admin', name: 'Admin' }) });
    guardSees('gA', 1); // this user is the only one

    await expect(removeUserFromRole('org-1', 'gA', 'victim', { actorUserId: 'owner-not-in-role' }))
      .rejects.toThrow(RL_LAST_PRIVILEGED_MEMBER);
    expect(mockGmDeleteOne).not.toHaveBeenCalled();
  });

  it('allows removing a non-last member of a privilege-granting Role', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gA', grantsRole: 'admin', name: 'Admin' }) });
    findReturns(mockGmFind, []);
    findReturns(mockGroupFind, []);
    guardSees('gA', 2); // another admin remains
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

  it('SECURITY: a roles:manage delegate CANNOT remove a member of a role granting permissions they lack', async () => {
    // Symmetry with addUserToRole's ceiling: a delegate can't strip protection
    // from (or grief membership of) the built-in Admin Role.
    mockGroupFindOne.mockReturnValue({
      select: () => Promise.resolve({
        _id: 'gAdmin',
        grantsRole: 'admin',
        name: 'Admin',
        permissions: ['members:manage', 'org:settings'],
      }),
    });

    await expect(removeUserFromRole('org-1', 'gAdmin', 'victim', {
      actorUserId: 'delegate', actorIsOrgAdmin: false, actorPermissions: ['roles:manage'],
    })).rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);
    expect(mockGmDeleteOne).not.toHaveBeenCalled();
  });

  it('allows an org admin to remove a member of the built-in Admin Role (ceiling bypassed)', async () => {
    mockGroupFindOne.mockReturnValue({
      select: () => Promise.resolve({
        _id: 'gAdmin',
        grantsRole: 'admin',
        name: 'Admin',
        permissions: ['members:manage', 'org:settings'],
      }),
    });
    findReturns(mockGmFind, []);
    findReturns(mockGroupFind, []);
    guardSees('gAdmin', 2); // not the last member
    mockUoFindOne.mockReturnValue({ session: () => ({ role: 'admin', save: jest.fn().mockResolvedValue(undefined) }) });

    await removeUserFromRole('org-1', 'gAdmin', 'victim', {
      actorUserId: 'other-admin', actorIsOrgAdmin: true, actorPermissions: [],
    });

    expect(mockGmDeleteOne).toHaveBeenCalledWith({ userId: 'victim', roleId: 'gAdmin' }, { session: expect.anything() });
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

    await updateRole('org-1', 'gCustom', { permissions: ['pipelines:write'] }, { permissions: [], isSuperAdmin: true, isOrgAdmin: false });

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

    await updateRole('org-1', 'gCustom', { description: 'renamed' }, { permissions: [], isSuperAdmin: true, isOrgAdmin: false });

    expect(doc.save).toHaveBeenCalledWith({ session: expect.anything() });
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  describe('permission ceiling on the EXISTING permission set (strip guard)', () => {
    /** A custom Role granting a capability a `roles:manage` delegate lacks. */
    const billingRole = () => ({
      _id: 'gBilling',
      name: 'Billing Managers',
      system: false,
      permissions: ['billing:manage'],
      save: jest.fn().mockResolvedValue(undefined),
    });
    const delegate = (permissions: string[]) => ({ permissions, isSuperAdmin: false, isOrgAdmin: false });

    it('SECURITY: a roles:manage delegate CANNOT rewrite a role granting a permission they lack', async () => {
      // The delete path already blocked this; without the same check here the
      // griefing vector is simply reachable through update — rewriting the role
      // down to `roles:manage` revokes billing:manage from every member.
      const doc = billingRole();
      mockGroupFindOne.mockResolvedValue(doc);

      await expect(updateRole('org-1', 'gBilling', { permissions: ['roles:manage'] }, delegate(['roles:manage'])))
        .rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);

      // Refused BEFORE any write — and crucially before the member tokenVersion
      // bump, so no one's grants are disturbed by the refused edit.
      expect(doc.save).not.toHaveBeenCalled();
      expect(mockUserUpdateMany).not.toHaveBeenCalled();
    });

    it('SECURITY: the guard also covers a name-only edit of an out-of-ceiling role', async () => {
      const doc = billingRole();
      mockGroupFindOne.mockResolvedValue(doc);

      await expect(updateRole('org-1', 'gBilling', { name: 'Renamed' }, delegate(['roles:manage'])))
        .rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);
      expect(doc.save).not.toHaveBeenCalled();
    });

    it('allows a delegate to edit a role whose existing permissions are within their own set', async () => {
      const doc = roleDoc(); // grants pipelines:read
      mockGroupFindOne.mockResolvedValue(doc);
      findReturns(mockGmFind, []);

      await updateRole('org-1', 'gCustom', { permissions: ['pipelines:read'] }, delegate(['pipelines:read', 'roles:manage']));

      expect(doc.save).toHaveBeenCalledWith({ session: expect.anything() });
    });

    it('an org admin/owner bypasses the ceiling, as on the delete path', async () => {
      const doc = billingRole();
      mockGroupFindOne.mockResolvedValue(doc);
      findReturns(mockGmFind, []);

      // Description-only edit: a rename would additionally hit the name-clash
      // lookup, which isn't what this test is about.
      await updateRole('org-1', 'gBilling', { description: 'still billing' }, { permissions: [], isSuperAdmin: false, isOrgAdmin: true });

      expect(doc.save).toHaveBeenCalledWith({ session: expect.anything() });
    });
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
    // a real change clears the refresh-session slots
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { refreshSessions: [] } }, expect.anything());
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
    expect(mockUserUpdateOne).not.toHaveBeenCalledWith({ _id: 'u1' }, { $set: { refreshSessions: [] } }, expect.anything());
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
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { refreshSessions: [] } }, expect.anything());
    expect(result).toEqual({ changed: true });
  });

  it('throws RL_SUPERADMIN_ROLE_MISSING when the system org has no Super Admin Role', async () => {
    superAdminRoleFound(null);
    await expect(grantPlatformAdmin('u1')).rejects.toThrow(RL_SUPERADMIN_ROLE_MISSING);
  });
});

describe('assertActorMayAssignBuiltinAdmin — Admin-role grant ceiling outside the Role API', () => {
  const adminRole = (permissions: string[]) => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve({ permissions }) }) }) });

  it('refuses a members:manage delegate who lacks the Admin Role\'s permissions', async () => {
    mockGroupFindOne.mockReturnValue(adminRole(['members:manage', 'org:settings']));
    await expect(assertActorMayAssignBuiltinAdmin('org-1', delegateActor(['members:manage'])))
      .rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);
  });

  it('admits a delegate holding every Admin permission, and org admins / superadmins without a lookup', async () => {
    mockGroupFindOne.mockReturnValue(adminRole(['members:manage']));
    await expect(assertActorMayAssignBuiltinAdmin('org-1', delegateActor(['members:manage', 'x']))).resolves.toBeUndefined();
    mockGroupFindOne.mockClear();
    await assertActorMayAssignBuiltinAdmin('org-1', orgAdminActor);
    await assertActorMayAssignBuiltinAdmin('org-1', superAdminActor);
    expect(mockGroupFindOne).not.toHaveBeenCalled();
  });
});

describe('listRolesWithMembers — paging', () => {
  /** Role.find().sort()[.skip().limit()].lean() → roles; records skip/limit. */
  let skipped: number | undefined;
  let limited: number | undefined;
  const roleRows = [
    { _id: 'r-admin', name: 'Admin', grantsRole: 'admin', permissions: ['org:settings'], system: true },
    { _id: 'r-qa', name: 'QA', grantsRole: 'member', permissions: [], system: false },
  ];
  beforeEach(() => {
    skipped = undefined;
    limited = undefined;
    const chain: any = {
      skip: (n: number) => { skipped = n; return chain; },
      limit: (n: number) => { limited = n; return chain; },
      lean: () => Promise.resolve(roleRows),
    };
    mockGroupFind.mockReturnValue({ sort: () => chain });
    mockGroupCount.mockResolvedValue(7);
    mockGmFind.mockReturnValue({
      populate: () => ({
        lean: () => Promise.resolve([
          { roleId: 'r-qa', userId: { _id: 'u1', username: 'ann', email: 'ann@x.io' } },
          { roleId: 'r-qa', userId: null }, // deleted user — skipped
        ]),
      }),
    });
  });

  it('returns every Role (no skip/limit) when no page is asked for, with the org-wide total', async () => {
    const out = await listRolesWithMembers('org-1');

    expect(skipped).toBeUndefined();
    expect(limited).toBeUndefined();
    expect(out.total).toBe(7);
    expect(out.roles.map((r: any) => r.id)).toEqual(['r-admin', 'r-qa']);
    expect(out.roles[1].members).toEqual([{ id: 'u1', username: 'ann', email: 'ann@x.io' }]);
  });

  it('pages the Roles and loads members only for the page\'s Roles', async () => {
    const out = await listRolesWithMembers('org-1', { limit: 2, offset: 4 });

    expect(skipped).toBe(4);
    expect(limited).toBe(2);
    expect(out.total).toBe(7);
    const assignmentFilter = mockGmFind.mock.calls[0]![0] as any;
    expect(assignmentFilter).toEqual({ organizationId: 'org-1', roleId: { $in: ['r-admin', 'r-qa'] } });
  });

  it('skips the assignment read for an empty page', async () => {
    mockGroupFind.mockReturnValue({ sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) });

    const out = await listRolesWithMembers('org-1', { limit: 20, offset: 40 });

    expect(out).toEqual({ roles: [], total: 7 });
    expect(mockGmFind).not.toHaveBeenCalled();
  });
});
