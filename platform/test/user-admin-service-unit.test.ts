// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for UserAdminService's read helpers and delete orchestration
 * (services/user-admin-service.ts), with the model layer mocked:
 *   - org-scope / role-scope id lookups query ACTIVE memberships only;
 *   - `list` applies the id scope + an escaped search, and resolves memberships
 *     and org names without extra reads when there is nothing to resolve;
 *   - `getByIdWithOrgs`, `hasMembershipInOrg`, `lookupPrimaryOrgId` shape and
 *     prefer the right sources;
 *   - `deleteUserById` runs the cascade in a transaction, then revokes and
 *     anonymizes POST-commit, and reports a missing user.
 * createUser / updateUserById / updateFeatures have their own suites.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { queryChain } from './helpers/query-chain.js';
import { seatsMock } from './helpers/seats-mock.js';

type Fn = (...a: unknown[]) => unknown;
type AFn = (...a: unknown[]) => Promise<unknown>;

const mockUserFind = jest.fn<Fn>();
const mockUserCount = jest.fn<AFn>();
const mockUserFindById = jest.fn<Fn>();
const mockUoFind = jest.fn<Fn>();
const mockUoFindOne = jest.fn<Fn>();
const mockOrgFind = jest.fn<Fn>();
const mockCascade = jest.fn<AFn>();
const mockPublishDeletion = jest.fn<AFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/services/user-cascade.js', () => ({
  deleteUserCascade: (...a: unknown[]) => mockCascade(...a),
}));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: jest.fn(async () => undefined),
  publishUserDeletionRevocation: (...a: unknown[]) => mockPublishDeletion(...a),
}));
jest.unstable_mockModule('../src/helpers/active-org-info.js', () => ({
  loadActiveOrgInfo: jest.fn(async () => ({ organizationName: null, activeOrgRole: undefined, tier: 'developer' })),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/helpers/seats.js', () => seatsMock({}));
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  assertNewPasswordAcceptable: jest.fn(async () => undefined),
}));
const fakeSession = { id: 'sess' };
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => Promise<unknown>) => fn(fakeSession),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  assertActorMayAssignBuiltinAdmin: jest.fn(),
  recomputeUserOrgRole: jest.fn(),
  ensureBaselineRole: jest.fn(),
  assignBuiltinAdminRole: jest.fn(),
  removeBuiltinAdminRole: jest.fn(),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {
    find: (...a: unknown[]) => mockUserFind(...a),
    countDocuments: (...a: unknown[]) => mockUserCount(...a),
    findById: (...a: unknown[]) => mockUserFindById(...a),
  },
  Organization: { find: (...a: unknown[]) => mockOrgFind(...a) },
  UserOrganization: {
    find: (...a: unknown[]) => mockUoFind(...a),
    findOne: (...a: unknown[]) => mockUoFindOne(...a),
  },
  Role: {},
  RoleAssignment: {},
}));

const { userAdminService } = await import('../src/services/user-admin-service.js');

/** `UserOrganization.find(...).distinct(...)` → `ids`. */
const distinctOf = (ids: unknown[]) => ({ distinct: async () => ids });

beforeEach(() => {
  jest.clearAllMocks();
  mockUserFind.mockReturnValue(queryChain([]));
  mockUserCount.mockResolvedValue(0);
  mockUoFind.mockReturnValue(queryChain([]));
  mockOrgFind.mockReturnValue(queryChain([]));
  mockPublishDeletion.mockResolvedValue(undefined);
});

describe('org-scope id lookups', () => {
  it('reads the active members of an org', async () => {
    const ids = [new Types.ObjectId()];
    mockUoFind.mockReturnValue(distinctOf(ids));
    await expect(userAdminService.getUserIdsInOrg('org-1')).resolves.toEqual(ids);
    expect(mockUoFind).toHaveBeenCalledWith({ organizationId: 'org-1', isActive: true });
  });

  it('reads the active holders of a role in an org', async () => {
    mockUoFind.mockReturnValue(distinctOf([]));
    await expect(userAdminService.getUserIdsByRoleInOrg('org-1', 'admin')).resolves.toEqual([]);
    expect(mockUoFind).toHaveBeenCalledWith({ organizationId: 'org-1', role: 'admin', isActive: true });
  });
});

describe('list', () => {
  it('skips the membership and org reads when no user matches', async () => {
    const result = await userAdminService.list(null, {}, 0, 20);
    expect(result).toMatchObject({ users: [], total: 0 });
    expect(mockUserFind).toHaveBeenCalledWith({});
    expect(mockUoFind).not.toHaveBeenCalled();
    expect(mockOrgFind).not.toHaveBeenCalled();
  });

  it('scopes by id + search, groups memberships per user and resolves org names', async () => {
    const u1 = new Types.ObjectId();
    const u2 = new Types.ObjectId();
    const o1 = new Types.ObjectId();
    mockUserFind.mockReturnValue(queryChain([{ _id: u1 }, { _id: u2 }]));
    mockUserCount.mockResolvedValue(2);
    mockUoFind.mockReturnValue(queryChain([
      { userId: u1, organizationId: o1, role: 'admin' },
      { userId: u1, organizationId: o1.toString(), role: 'member' },
      { userId: u2, organizationId: o1, role: 'member' },
    ]));
    mockOrgFind.mockReturnValue(queryChain([{ _id: o1, name: 'Acme' }]));

    const result = await userAdminService.list([u1, u2], { search: 'bob' }, 0, 20);

    const filter = mockUserFind.mock.calls[0][0] as Record<string, unknown>;
    expect(filter._id).toEqual({ $in: [u1, u2] });
    expect(filter.$or).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.membershipsByUser.get(u1.toString())).toHaveLength(2);
    expect(result.membershipsByUser.get(u2.toString())).toHaveLength(1);
    expect(result.orgNameMap.get(o1.toString())).toBe('Acme');
    // The two spellings of o1 dedup to one org read.
    expect((mockOrgFind.mock.calls[0][0] as { _id: { $in: unknown[] } })._id.$in).toHaveLength(1);
  });

  it('skips the org read when the users hold no memberships', async () => {
    mockUserFind.mockReturnValue(queryChain([{ _id: new Types.ObjectId() }]));
    const result = await userAdminService.list(null, {}, 0, 20);
    expect(result.membershipsByUser.size).toBe(0);
    expect(mockOrgFind).not.toHaveBeenCalled();
  });
});

describe('getByIdWithOrgs', () => {
  it('throws UA_USER_NOT_FOUND for a missing user', async () => {
    mockUserFindById.mockReturnValue(queryChain(null));
    await expect(userAdminService.getByIdWithOrgs('u')).rejects.toThrow('UA_USER_NOT_FOUND');
  });

  it('returns the user with no org read when they hold no memberships', async () => {
    mockUserFindById.mockReturnValue(queryChain({ _id: 'u', username: 'bob' }));
    const result = await userAdminService.getByIdWithOrgs('u');
    expect(result.user).toMatchObject({ username: 'bob' });
    expect(result.memberships).toEqual([]);
    expect(result.orgMap.size).toBe(0);
    expect(mockOrgFind).not.toHaveBeenCalled();
  });

  it('maps the user\'s orgs by id', async () => {
    mockUserFindById.mockReturnValue(queryChain({ _id: 'u' }));
    mockUoFind.mockReturnValue(queryChain([{ organizationId: 'o1' }]));
    mockOrgFind.mockReturnValue(queryChain([{ _id: 'o1', name: 'Acme' }]));
    const result = await userAdminService.getByIdWithOrgs('u');
    expect(result.orgMap.get('o1')).toMatchObject({ name: 'Acme' });
  });
});

describe('membership helpers', () => {
  it('hasMembershipInOrg reflects an active membership row', async () => {
    mockUoFindOne.mockReturnValueOnce(Promise.resolve({ _id: 'm' }));
    await expect(userAdminService.hasMembershipInOrg('u', 'org-1')).resolves.toBe(true);
    mockUoFindOne.mockReturnValueOnce(Promise.resolve(null));
    await expect(userAdminService.hasMembershipInOrg('u', 'org-1')).resolves.toBe(false);
    expect(mockUoFindOne).toHaveBeenCalledWith({ userId: 'u', organizationId: 'org-1', isActive: true });
  });

  it('lookupPrimaryOrgId prefers lastActiveOrgId, then the first active membership', async () => {
    mockUserFindById.mockReturnValueOnce(queryChain({ lastActiveOrgId: 'last' }));
    await expect(userAdminService.lookupPrimaryOrgId('u')).resolves.toBe('last');
    expect(mockUoFindOne).not.toHaveBeenCalled();

    mockUserFindById.mockReturnValueOnce(queryChain({}));
    mockUoFindOne.mockReturnValueOnce(queryChain({ organizationId: 'member-org' }));
    await expect(userAdminService.lookupPrimaryOrgId('u')).resolves.toBe('member-org');

    mockUserFindById.mockReturnValueOnce(queryChain(null));
    mockUoFindOne.mockReturnValueOnce(queryChain(null));
    await expect(userAdminService.lookupPrimaryOrgId('u')).resolves.toBeUndefined();
  });
});

describe('deleteUserById', () => {
  // The ecosystem erasure is no longer a post-commit call: the cascade enqueues
  // its outbox leg inside the transaction (see user-cascade.test.ts).
  it('runs the cascade in a transaction, then revokes post-commit', async () => {
    mockCascade.mockResolvedValue({ accessVersion: 7 });
    await userAdminService.deleteUserById('u');
    expect(mockCascade).toHaveBeenCalledWith(fakeSession, 'u');
    expect(mockPublishDeletion).toHaveBeenCalledWith('u', 7);
  });

  it('throws UA_USER_NOT_FOUND and does nothing post-commit when the user is gone', async () => {
    mockCascade.mockResolvedValue(null);
    await expect(userAdminService.deleteUserById('u')).rejects.toThrow('UA_USER_NOT_FOUND');
    expect(mockPublishDeletion).not.toHaveBeenCalled();
  });
});
