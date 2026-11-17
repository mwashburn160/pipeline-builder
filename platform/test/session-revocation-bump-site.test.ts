// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Representative bump-site test: an access change that bumps the access version
 * must PUBLISH the user's new version to the stateless services after the
 * transaction commits. We use OrgMembersService.removeMember and assert it calls
 * `publishUserRevocation(userId)` (the session-revocation helper is mocked so we
 * assert the call, not the Redis write — that's covered in session-revocation.test).
 *
 * removeMember's bump is a CLAIMS bump scoped to the org (the SCIM
 * `endOrgAccess` approach) — never a `tokenVersion` bump + session wipe, which
 * signed the person out of every OTHER org too. It also runs the Role-unassign
 * guards (`assertActorMayStripMemberRoles`) before deleting anything, and
 * re-derives `User.isSuperAdmin` when a superadmin-granting Role went with them.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { seatsMock } from './helpers/seats-mock.js';

const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUoDeleteOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRaDeleteMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPublishUser = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockPublishUsers = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ isAncestorOrg: async () => false, expandOrgScope: async (id: string) => [id] }));
jest.unstable_mockModule('../src/helpers/seats.js', () => seatsMock({
  seatCapacityAvailable: jest.fn(async () => true),
  seatCapacityStillWithinCap: jest.fn(async () => true),
  userHasSeatInAccount: jest.fn(async () => false),
}));
const mockRecompute = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ assertActorMayAssignBuiltinAdmin: async () => undefined, ensureBaselineRole: jest.fn(async () => undefined), assignBuiltinAdminRole: jest.fn(async () => true), recomputeUserOrgRole: (...a: unknown[]) => mockRecompute(...a) }));
const mockStripGuard = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockWieldGuard = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => []);
jest.unstable_mockModule('../src/services/role-crud.js', () => ({ assertActorMayStripMemberRoles: (...a: unknown[]) => mockStripGuard(...a), assertActorMayWieldMemberRoles: (...a: unknown[]) => mockWieldGuard(...a) }));
jest.unstable_mockModule('../src/helpers/account-membership.js', () => ({ assertDirectAddConsented: jest.fn(async () => undefined) }));

// The publisher under assertion — mocked so we verify the call, not the Redis I/O.
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: async () => true,
  publishAccessKeyRevocation: async () => true,
  publishUserRevocation: (...a: unknown[]) => mockPublishUser(...a),
  publishUsersRevocation: (...a: unknown[]) => mockPublishUsers(...a),
}));

jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: { findById: jest.fn() },
  User: { updateOne: (...a: unknown[]) => mockUserUpdateOne(...a) },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUoFindOne(...a),
    deleteOne: (...a: unknown[]) => mockUoDeleteOne(...a),
  },
  // removeMember now deletes the user's role assignments for the org in-tx
  // (privilege-resurrection fix); called with the `{ session }` option form.
  RoleAssignment: { deleteMany: (...a: unknown[]) => mockRaDeleteMany(...a) },
  // removeMember/deactivateMember revoke the member's pending invitations in-tx.
  Invitation: { find: () => ({ select: () => ({ session: () => ({ lean: async () => [] }) }) }), updateMany: async () => ({}) },
}));

const { orgMembersService } = await import('../src/services/org-members-service.js');

const findOneResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

const ADMIN = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateOne.mockResolvedValue(undefined);
  mockUoDeleteOne.mockReturnValue({ session: () => Promise.resolve(undefined) });
  mockRaDeleteMany.mockResolvedValue(undefined);
  mockStripGuard.mockResolvedValue({ heldSuperadmin: false });
});

describe('OrgMembersService.removeMember → session-revocation publish', () => {
  it('publishes the removed user\'s access version after an org-scoped CLAIMS bump', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ _id: 'm1', role: 'member' }));

    await orgMembersService.removeMember('org-1', 'user-1', ADMIN);

    // The claims bump happened...
    const bump = mockUserUpdateOne.mock.calls.find((c) => (c[1] as any)?.$inc?.claimsVersion === 1);
    expect(bump).toBeDefined();
    expect(bump![0]).toEqual({ _id: 'user-1' });
    // ...and the publisher was invoked for that user.
    expect(mockPublishUser).toHaveBeenCalledTimes(1);
    expect(mockPublishUser).toHaveBeenCalledWith('user-1');
  });

  it('does NOT sign the person out globally (no tokenVersion bump, refresh sessions kept)', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ _id: 'm1', role: 'member' }));

    await orgMembersService.removeMember('org-1', 'user-1', ADMIN);

    for (const [, update] of mockUserUpdateOne.mock.calls) {
      expect((update as any)?.$inc?.tokenVersion).toBeUndefined();
      expect((update as any)?.$set?.refreshSessions).toBeUndefined();
    }
    // The pin to the removed org is still dropped.
    const unpin = mockUserUpdateOne.mock.calls.find((c) => (c[0] as any)?.lastActiveOrgId === 'org-1');
    expect((unpin![1] as any).$unset).toHaveProperty('lastActiveOrgId');
  });

  it('drops ONLY the removed org\'s feature overrides (a stale grant must not re-apply on rejoin)', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ _id: 'm1', role: 'member' }));

    await orgMembersService.removeMember('org-1', 'user-1', ADMIN);

    const unset = mockUserUpdateOne.mock.calls.find((c) => (c[1] as any)?.$unset?.['featureOverrides.org-1'] !== undefined);
    expect(unset).toBeDefined();
    expect(unset![0]).toEqual({ _id: 'user-1' });
    // No other org's entry is touched.
    expect(Object.keys((unset![1] as any).$unset)).toEqual(['featureOverrides.org-1']);
  });

  it('runs the Role-unassign guards with the actor BEFORE deleting anything', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ _id: 'm1', role: 'admin' }));
    const peopleManager = { isSuperAdmin: false, isOrgAdmin: false, permissions: ['members:manage'] };
    mockStripGuard.mockRejectedValue(new Error('RL_ASSIGN_EXCEEDS_CEILING'));

    await expect(orgMembersService.removeMember('org-1', 'admin-1', peopleManager)).rejects.toThrow('RL_ASSIGN_EXCEEDS_CEILING');

    expect(mockStripGuard).toHaveBeenCalledWith('org-1', 'admin-1', peopleManager, expect.anything());
    expect(mockUoDeleteOne).not.toHaveBeenCalled();
    expect(mockRaDeleteMany).not.toHaveBeenCalled();
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
    expect(mockPublishUser).not.toHaveBeenCalled();
  });

  it('refuses to empty a privileged Role (last admin) — nothing is deleted', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ _id: 'm1', role: 'admin' }));
    mockStripGuard.mockRejectedValue(new Error('RL_LAST_PRIVILEGED_MEMBER'));

    await expect(orgMembersService.removeMember('org-1', 'admin-1', ADMIN)).rejects.toThrow('RL_LAST_PRIVILEGED_MEMBER');
    expect(mockRaDeleteMany).not.toHaveBeenCalled();
  });

  it('re-derives User.isSuperAdmin when a superadmin-granting Role went with the membership', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ _id: 'm1', role: 'admin' }));
    mockStripGuard.mockResolvedValue({ heldSuperadmin: true });

    await orgMembersService.removeMember('system-org', 'sa-1', { isSuperAdmin: true, isOrgAdmin: true, permissions: [] });

    expect(mockRaDeleteMany).toHaveBeenCalled();
    expect(mockRecompute).toHaveBeenCalledWith('sa-1', 'system-org', expect.anything());
    // After the assignments are gone, so the recompute sees none and clears the flag.
    expect(mockRaDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockRecompute.mock.invocationCallOrder[0]);
  });

  it('skips the recompute when no superadmin Role was held', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ _id: 'm1', role: 'member' }));
    await orgMembersService.removeMember('org-1', 'user-1', ADMIN);
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it('does not publish when the member is missing (no bump)', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving(null));
    await expect(orgMembersService.removeMember('org-1', 'ghost', ADMIN)).rejects.toThrow();
    expect(mockPublishUser).not.toHaveBeenCalled();
  });
});
