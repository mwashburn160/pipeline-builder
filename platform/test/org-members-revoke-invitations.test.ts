// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Removing or deactivating a member revokes the PENDING invitations they sent
 * into that org, in the same transaction as the membership change.
 *
 * An invitation is the sender's authority to admit someone, parked until the
 * invitee clicks. Left pending after the sender is gone, a removed member's
 * plain member invitations kept onboarding people (acceptance only re-checked
 * the inviter for admin / Role-carrying invitations). The service now writes
 * the same `revoked` status the manual revoke writes, and hands the revoked
 * rows back for the controller to audit.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { seatsMock } from './helpers/seats-mock.js';

const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUoDeleteOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRaDeleteMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockInvFind = jest.fn<(...a: unknown[]) => unknown>();
const mockInvUpdateMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockInvSession = jest.fn<(...a: unknown[]) => unknown>();
const mockStripGuard = jest.fn<(...a: unknown[]) => Promise<unknown>>();

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
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: jest.fn(async () => undefined),
  publishUsersRevocation: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/services/role-crud.js', () => ({
  assertActorMayStripMemberRoles: (...a: unknown[]) => mockStripGuard(...a),
  assertActorMayWieldMemberRoles: jest.fn(async () => []),
}));
jest.unstable_mockModule('../src/helpers/account-membership.js', () => ({ assertDirectAddConsented: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  assertActorMayAssignBuiltinAdmin: async () => undefined,
  ensureBaselineRole: jest.fn(async () => undefined),
  assignBuiltinAdminRole: jest.fn(async () => true),
  recomputeUserOrgRole: jest.fn(async () => undefined),
}));

const SESSION = { id: 'test-session' };
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb(SESSION),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: { findById: jest.fn() },
  User: { updateOne: (...a: unknown[]) => mockUserUpdateOne(...a) },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUoFindOne(...a),
    deleteOne: (...a: unknown[]) => mockUoDeleteOne(...a),
  },
  RoleAssignment: { deleteMany: (...a: unknown[]) => mockRaDeleteMany(...a) },
  Invitation: {
    find: (...a: unknown[]) => mockInvFind(...a),
    updateMany: (...a: unknown[]) => mockInvUpdateMany(...a),
  },
}));

const { orgMembersService } = await import('../src/services/org-members-service.js');

const ADMIN = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };
const sessionResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

const PENDING = [
  { _id: 'inv-1', organizationId: 'org-1', email: 'a@example.com', role: 'member' },
  { _id: 'inv-2', organizationId: 'org-1', email: 'b@example.com', role: 'admin' },
];

/** Invitation.find(filter).select(...).session(s).lean() → `rows`. */
function invitationsPending(rows: unknown[]) {
  mockInvFind.mockReturnValue({
    select: () => ({
      session: (s: unknown) => { mockInvSession(s); return { lean: async () => rows }; },
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateOne.mockResolvedValue(undefined);
  mockRaDeleteMany.mockResolvedValue(undefined);
  mockInvUpdateMany.mockResolvedValue({ modifiedCount: 2 });
  mockUoDeleteOne.mockReturnValue({ session: async () => ({}) });
  mockStripGuard.mockResolvedValue({ heldSuperadmin: false });
  invitationsPending(PENDING);
});

describe.each([
  ['removeMember', (o: string, u: string) => orgMembersService.removeMember(o, u, ADMIN)],
  ['deactivateMember', (o: string, u: string) => orgMembersService.deactivateMember(o, u, ADMIN)],
] as const)('OrgMembersService.%s — the member\'s pending invitations', (_name, run) => {
  beforeEach(() => {
    mockUoFindOne.mockReturnValue(sessionResolving({ _id: 'm1', role: 'member', isActive: true, save: jest.fn(async () => undefined) }));
  });

  it('revokes every pending invitation they sent into THIS org, in the same transaction', async () => {
    const out = await run('org-1', 'user-1');

    expect(mockInvFind).toHaveBeenCalledWith({ invitedBy: 'user-1', organizationId: 'org-1', status: 'pending' });
    expect(mockInvSession).toHaveBeenCalledWith(SESSION);
    expect(mockInvUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['inv-1', 'inv-2'] }, status: 'pending' },
      { $set: { status: 'revoked' } },
      { session: SESSION },
    );
    // Handed back (secret-free) for the controller's `invitation.revoke` audit.
    expect(out.revokedInvitations).toEqual([
      { invitationId: 'inv-1', organizationId: 'org-1', email: 'a@example.com', role: 'member' },
      { invitationId: 'inv-2', organizationId: 'org-1', email: 'b@example.com', role: 'admin' },
    ]);
  });

  it('writes nothing when they had none pending', async () => {
    invitationsPending([]);
    const out = await run('org-1', 'user-1');
    expect(mockInvUpdateMany).not.toHaveBeenCalled();
    expect(out.revokedInvitations).toEqual([]);
  });

  it('leaves invitations alone when the exit itself is refused', async () => {
    mockStripGuard.mockRejectedValue(new Error('RL_ASSIGN_EXCEEDS_CEILING'));
    await expect(run('org-1', 'user-1')).rejects.toThrow('RL_ASSIGN_EXCEEDS_CEILING');
    expect(mockInvFind).not.toHaveBeenCalled();
    expect(mockInvUpdateMany).not.toHaveBeenCalled();
  });
});
