// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the first-class Groups RBAC layer:
 *   - seedDefaultGroups: default groups on org create (+ Superadmins for the
 *     system org) and the creator's group membership / isSuperAdmin flag.
 *   - recomputeUserOrgRole: derive the cached UserOrganization.role from group
 *     membership (preserving `owner`; superadmin grants AND revokes isSuperAdmin
 *     within an org that defines a Superadmins group); bump tokenVersion on a
 *     genuine privilege change so it takes effect immediately (G1).
 *   - add/removeUserFromGroup: management entrypoints, error paths, and the
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
  Group: {
    create: (...a: unknown[]) => mockGroupCreate(...a),
    find: (...a: unknown[]) => mockGroupFind(...a),
    findOne: (...a: unknown[]) => mockGroupFindOne(...a),
    exists: (...a: unknown[]) => mockGroupExists(...a),
  },
  GroupMembership: {
    create: (...a: unknown[]) => mockGmCreate(...a),
    find: (...a: unknown[]) => mockGmFind(...a),
    updateOne: (...a: unknown[]) => mockGmUpdateOne(...a),
    deleteOne: (...a: unknown[]) => mockGmDeleteOne(...a),
    exists: (...a: unknown[]) => mockGmExists(...a),
    countDocuments: (...a: unknown[]) => mockGmCount(...a),
  },
  User: {
    updateOne: (...a: unknown[]) => mockUserUpdateOne(...a),
    findById: (...a: unknown[]) => mockUserFindById(...a),
    findOne: (...a: unknown[]) => mockUserFindOne(...a),
  },
  UserOrganization: { findOne: (...a: unknown[]) => mockUoFindOne(...a) },
}));

const {
  seedDefaultGroups, recomputeUserOrgRole, addUserToGroup, removeUserFromGroup,
  GRP_GROUP_NOT_FOUND, GRP_USER_NOT_FOUND, GRP_NOT_ORG_MEMBER,
  GRP_CANNOT_REMOVE_SELF, GRP_LAST_PRIVILEGED_MEMBER, GRP_REQUIRES_SUPERADMIN,
} = await import('../src/services/groups-service.js');

// Group.create echoes back the docs with a name-derived _id.
const echoCreate = () => mockGroupCreate.mockImplementation((docs: Array<{ name: string; grantsRole: string }>) =>
  Promise.resolve(docs.map((d) => ({ _id: `g-${d.name}`, name: d.name, grantsRole: d.grantsRole }))));
// find(...).session(...).select(...).lean()
const findReturns = (mock: jest.Mock, rows: unknown[]) =>
  mock.mockReturnValue({ session: () => ({ select: () => ({ lean: () => Promise.resolve(rows) }) }) });
// Group.exists(...).session(...) resolves to a truthy/null sentinel.
const orgHasSuperadminGroup = (has: boolean) =>
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
  orgHasSuperadminGroup(false); // default: ordinary org, isSuperAdmin untouched
});

describe('seedDefaultGroups', () => {
  it('seeds Administrators + Developers for a normal org; creator joins Administrators only', async () => {
    await seedDefaultGroups('org-1', 'u1', {});

    const seeded = mockGroupCreate.mock.calls[0][0] as Array<{ name: string; grantsRole: string; system: boolean }>;
    expect(seeded.map((g) => g.name)).toEqual(['Administrators', 'Developers']);
    expect(seeded.every((g) => g.system)).toBe(true);

    const memberships = mockGmCreate.mock.calls[0][0] as Array<{ userId: string; groupId: string }>;
    expect(memberships.map((m) => m.groupId)).toEqual(['g-Administrators']);
    expect(mockUserUpdateOne).not.toHaveBeenCalled(); // no isSuperAdmin for a normal org
  });

  it('seeds Superadmins for the system org; creator joins Superadmins + Administrators and is flagged isSuperAdmin', async () => {
    await seedDefaultGroups('000000000000000000000001', 'u1', { isSystemOrg: true });

    const seeded = mockGroupCreate.mock.calls[0][0] as Array<{ name: string }>;
    expect(seeded.map((g) => g.name)).toEqual(['Superadmins', 'Administrators', 'Developers']);

    const memberships = mockGmCreate.mock.calls[0][0] as Array<{ groupId: string }>;
    expect(memberships.map((m) => m.groupId)).toEqual(['g-Superadmins', 'g-Administrators']);
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { isSuperAdmin: true } }, expect.anything());
  });
});

describe('recomputeUserOrgRole', () => {
  it('sets role=admin when the user is in an admin-granting group, and bumps tokenVersion (G1)', async () => {
    findReturns(mockGmFind, [{ groupId: 'gA' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'admin' }]);
    const uo = { role: 'member', save: jest.fn().mockResolvedValue(undefined) };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', 'org-1');

    expect(uo.role).toBe('admin');
    expect(uo.save).toHaveBeenCalled();
    // G1: the role flip must invalidate existing tokens.
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $inc: { tokenVersion: 1 } }, expect.anything());
  });

  it('preserves owner regardless of groups and does NOT bump tokenVersion', async () => {
    findReturns(mockGmFind, [{ groupId: 'gD' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);
    const uo = { role: 'owner', save: jest.fn() };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', 'org-1');

    expect(uo.role).toBe('owner');
    expect(uo.save).not.toHaveBeenCalled();
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('does NOT bump tokenVersion when nothing changes (member stays member)', async () => {
    findReturns(mockGmFind, [{ groupId: 'gD' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);
    const uo = { role: 'member', save: jest.fn() };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', 'org-1');

    expect(uo.save).not.toHaveBeenCalled();
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('a superadmin group flags isSuperAdmin (genuine flip), yields admin role, and bumps tokenVersion', async () => {
    findReturns(mockGmFind, [{ groupId: 'gS' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'superadmin' }]);
    orgHasSuperadminGroup(true);
    currentIsSuperAdmin(false); // not a superadmin yet → flip to true
    const uo = { role: 'member', save: jest.fn().mockResolvedValue(undefined) };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', '000000000000000000000001');

    expect(uo.role).toBe('admin');
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { isSuperAdmin: true } }, expect.anything());
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $inc: { tokenVersion: 1 } }, expect.anything());
  });

  it('DEMOTES isSuperAdmin when no longer in a superadmin group (system org) and bumps tokenVersion', async () => {
    findReturns(mockGmFind, [{ groupId: 'gD' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);
    orgHasSuperadminGroup(true);
    currentIsSuperAdmin(true); // was a superadmin → flip to false
    const uo = { role: 'admin', save: jest.fn().mockResolvedValue(undefined) };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', '000000000000000000000001');

    expect(uo.role).toBe('member');
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { isSuperAdmin: false } }, expect.anything());
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $inc: { tokenVersion: 1 } }, expect.anything());
  });

  it('does not write isSuperAdmin when the flag is already correct (no spurious tokenVersion bump)', async () => {
    findReturns(mockGmFind, [{ groupId: 'gD' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'member' }]);
    orgHasSuperadminGroup(true);
    currentIsSuperAdmin(false); // already false, target false → no change
    const uo = { role: 'member', save: jest.fn() };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', '000000000000000000000001');

    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('never touches isSuperAdmin in an org with no superadmin group', async () => {
    findReturns(mockGmFind, [{ groupId: 'gA' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'admin' }]);
    orgHasSuperadminGroup(false);
    const uo = { role: 'member', save: jest.fn().mockResolvedValue(undefined) };
    mockUoFindOne.mockReturnValue({ session: () => uo });

    await recomputeUserOrgRole('u1', 'org-1');

    expect(mockUserFindById).not.toHaveBeenCalled(); // no read of the flag at all
    // tokenVersion bump (role changed) is fine, but no isSuperAdmin write.
    const setCalls = mockUserUpdateOne.mock.calls.filter((c) => (c[1] as { $set?: { isSuperAdmin?: unknown } })?.$set?.isSuperAdmin !== undefined);
    expect(setCalls).toHaveLength(0);
  });
});

describe('addUserToGroup error paths', () => {
  it('throws GRP_GROUP_NOT_FOUND when the group is missing', async () => {
    mockGroupFindOne.mockResolvedValue(null);
    await expect(addUserToGroup('org-1', 'gX', { userId: 'u1' }, false)).rejects.toThrow(GRP_GROUP_NOT_FOUND);
  });

  it('throws GRP_USER_NOT_FOUND when the user does not exist', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gA' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve(null) });
    await expect(addUserToGroup('org-1', 'gA', { userId: 'nope' }, false)).rejects.toThrow(GRP_USER_NOT_FOUND);
  });

  it('throws GRP_NOT_ORG_MEMBER when the user is not in the org', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gA' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'u1' }) });
    mockUoFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    await expect(addUserToGroup('org-1', 'gA', { userId: 'u1' }, false)).rejects.toThrow(GRP_NOT_ORG_MEMBER);
  });

  it('upserts membership and recomputes the role on success', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gA' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'u1' }) });
    mockUoFindOne
      .mockReturnValueOnce({ select: () => Promise.resolve({ _id: 'm1' }) }) // org-membership check
      .mockReturnValue({ session: () => ({ role: 'member', save: jest.fn().mockResolvedValue(undefined) }) }); // recompute
    mockGmUpdateOne.mockResolvedValue({});
    findReturns(mockGmFind, [{ groupId: 'gA' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'admin' }]);

    const res = await addUserToGroup('org-1', 'gA', { userId: 'u1' }, false);

    expect(res).toEqual({ userId: 'u1' });
    expect(mockGmUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', groupId: 'gA' },
      { $setOnInsert: { userId: 'u1', groupId: 'gA', organizationId: 'org-1' } },
      { upsert: true, session: expect.anything() },
    );
  });

  it('SECURITY: a non-superadmin cannot add a member to a superadmin-granting group', async () => {
    // The system-org Superadmins group. A mere org admin (actorIsSuperAdmin=false)
    // must be rejected BEFORE any membership write — otherwise recomputeUserOrgRole
    // would mint a platform superadmin (privilege escalation).
    mockGroupFindOne.mockResolvedValue({ _id: 'gS', grantsRole: 'superadmin' });

    await expect(addUserToGroup('000000000000000000000001', 'gS', { userId: 'u1' }, false))
      .rejects.toThrow(GRP_REQUIRES_SUPERADMIN);
    expect(mockGmUpdateOne).not.toHaveBeenCalled();
  });

  it('allows a platform superadmin to add a member to a superadmin-granting group', async () => {
    mockGroupFindOne.mockResolvedValue({ _id: 'gS', grantsRole: 'superadmin' });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve({ _id: 'u1' }) });
    mockUoFindOne
      .mockReturnValueOnce({ select: () => Promise.resolve({ _id: 'm1' }) })
      .mockReturnValue({ session: () => ({ role: 'member', save: jest.fn().mockResolvedValue(undefined) }) });
    mockGmUpdateOne.mockResolvedValue({});
    findReturns(mockGmFind, [{ groupId: 'gS' }]);
    findReturns(mockGroupFind, [{ grantsRole: 'superadmin' }]);

    const res = await addUserToGroup('000000000000000000000001', 'gS', { userId: 'u1' }, true);

    expect(res).toEqual({ userId: 'u1' });
    expect(mockGmUpdateOne).toHaveBeenCalled();
  });
});

describe('removeUserFromGroup', () => {
  it('throws GRP_GROUP_NOT_FOUND when the group is missing', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    await expect(removeUserFromGroup('org-1', 'gX', 'u1')).rejects.toThrow(GRP_GROUP_NOT_FOUND);
  });

  it('deletes the membership and recomputes for a member-only group (no guards)', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gD', grantsRole: 'member', name: 'Developers' }) });
    findReturns(mockGmFind, []);
    mockUoFindOne.mockReturnValue({ session: () => ({ role: 'admin', save: jest.fn().mockResolvedValue(undefined) }) });

    await removeUserFromGroup('org-1', 'gD', 'u1');

    expect(mockGmDeleteOne).toHaveBeenCalledWith({ userId: 'u1', groupId: 'gD' }, { session: expect.anything() });
    expect(mockGmExists).not.toHaveBeenCalled(); // member-only → guards skipped
  });

  it('G2: blocks removing yourself from a privilege-granting group', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gA', grantsRole: 'admin', name: 'Administrators' }) });
    mockGmExists.mockResolvedValue({ _id: 'm1' }); // the actor IS a member

    await expect(removeUserFromGroup('org-1', 'gA', 'u1', { actorUserId: 'u1' }))
      .rejects.toThrow(GRP_CANNOT_REMOVE_SELF);
    expect(mockGmDeleteOne).not.toHaveBeenCalled();
  });

  it('G3: blocks removing the last member of a privilege-granting group', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gA', grantsRole: 'admin', name: 'Administrators' }) });
    mockGmExists.mockResolvedValue({ _id: 'm1' });
    mockGmCount.mockResolvedValue(1); // this user is the only one

    await expect(removeUserFromGroup('org-1', 'gA', 'victim', { actorUserId: 'owner-not-in-group' }))
      .rejects.toThrow(GRP_LAST_PRIVILEGED_MEMBER);
    expect(mockGmDeleteOne).not.toHaveBeenCalled();
  });

  it('allows removing a non-last member of a privilege-granting group', async () => {
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gA', grantsRole: 'admin', name: 'Administrators' }) });
    mockGmExists.mockResolvedValue({ _id: 'm1' });
    mockGmCount.mockResolvedValue(2); // another admin remains
    findReturns(mockGmFind, []);
    mockUoFindOne.mockReturnValue({ session: () => ({ role: 'admin', save: jest.fn().mockResolvedValue(undefined) }) });

    await removeUserFromGroup('org-1', 'gA', 'victim', { actorUserId: 'other-admin' });

    expect(mockGmDeleteOne).toHaveBeenCalledWith({ userId: 'victim', groupId: 'gA' }, { session: expect.anything() });
  });

  it('SECURITY: a non-superadmin cannot remove a member of a superadmin-granting group', async () => {
    // Reverse of the escalation: stops a system-org admin from stripping
    // isSuperAdmin off a real superadmin via the recompute.
    mockGroupFindOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'gS', grantsRole: 'superadmin', name: 'Superadmins' }) });

    await expect(removeUserFromGroup('000000000000000000000001', 'gS', 'victim', { actorUserId: 'admin', actorIsSuperAdmin: false }))
      .rejects.toThrow(GRP_REQUIRES_SUPERADMIN);
    expect(mockGmDeleteOne).not.toHaveBeenCalled();
  });
});
