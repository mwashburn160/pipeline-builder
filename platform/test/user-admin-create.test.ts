// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for UserAdminService.createUser.
 *
 * Same approach as auth-service.test.ts: the model layer is fully mocked and
 * `withMongoTransaction` is stubbed to invoke the callback with a fake session,
 * so what we assert is the ORCHESTRATION — the per-field uniqueness checks
 * short-circuit with the right specific error, the org-assignment branch looks
 * up the org + writes a membership, the admin-created user is pre-verified, and
 * a missing org throws UA_ORG_NOT_FOUND before any user is saved.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUserExists = jest.fn<(...a: unknown[]) => unknown>();
const mockUserSave = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUserOrgCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockGroupFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockGroupMembershipUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRecomputeUserOrgRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockEnsureBaselineRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAssignBuiltinAdminRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRemoveBuiltinAdminRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();

// Recording constructor for `new User(...)` — captures the last-built instance.
let lastUser: any;
class MockUser {
  _id = { toString: () => 'user-1' };
  save = mockUserSave;
  [k: string]: unknown;
  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
    lastUser = this;
  }
  static exists = (...a: unknown[]) => mockUserExists(...a);
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('../src/helpers/active-org-info.js', () => ({
  loadActiveOrgInfo: jest.fn(async () => ({ organizationName: null, activeOrgRole: undefined, tier: 'developer' })),
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  toOrgId: (v: unknown) => v,
}));

jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  seatCapacityAvailable: jest.fn(async () => true),
}));

jest.unstable_mockModule('../src/utils/regex.js', () => ({
  escapeRegex: (s: string) => s,
}));

// Invoke the callback with a fake session — no real Mongo. On throw the error
// propagates (the real driver aborts the tx, leaving no partial writes).
const fakeSession = { id: 'sess' };
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => Promise<unknown>) => fn(fakeSession),
}));

// roles-service is reused by createUser for the role path — mock it so we
// assert the orchestration (upsert per role + a single recompute) without the
// real role-derivation machinery.
const RL_ROLE_NOT_FOUND = 'RL_ROLE_NOT_FOUND';
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  RL_ROLE_NOT_FOUND,
  recomputeUserOrgRole: (...a: unknown[]) => mockRecomputeUserOrgRole(...a),
  ensureBaselineRole: (...a: unknown[]) => mockEnsureBaselineRole(...a),
  assignBuiltinAdminRole: (...a: unknown[]) => mockAssignBuiltinAdminRole(...a),
  removeBuiltinAdminRole: (...a: unknown[]) => mockRemoveBuiltinAdminRole(...a),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: MockUser,
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  UserOrganization: { create: (...a: unknown[]) => mockUserOrgCreate(...a) },
  Role: { findOne: (...a: unknown[]) => mockGroupFindOne(...a) },
  RoleAssignment: { updateOne: (...a: unknown[]) => mockGroupMembershipUpdateOne(...a) },
}));

const { userAdminService, UA_USERNAME_TAKEN, UA_EMAIL_TAKEN, UA_ORG_NOT_FOUND, UA_ROLES_NEED_ORG } =
  await import('../src/services/user-admin-service.js');

/** `User.exists(...)` returns a query with a `.session()` that resolves to `val`. */
const existsResolving = (val: unknown) => ({ session: () => Promise.resolve(val) });
/** `Organization.findById(...)` returns a query with a `.session()` resolving to `val`. */
const findByIdResolving = (val: unknown) => ({ session: () => Promise.resolve(val) });

beforeEach(() => {
  jest.clearAllMocks();
  lastUser = undefined;
  mockUserSave.mockResolvedValue(undefined);
  mockUserOrgCreate.mockResolvedValue(undefined);
  mockGroupMembershipUpdateOne.mockResolvedValue(undefined);
  mockRecomputeUserOrgRole.mockResolvedValue(undefined);
  mockEnsureBaselineRole.mockResolvedValue(undefined);
  mockAssignBuiltinAdminRole.mockResolvedValue(true);
  mockRemoveBuiltinAdminRole.mockResolvedValue(undefined);
  // Default: every looked-up role exists.
  mockGroupFindOne.mockReturnValue(findByIdResolving({ _id: 'grp', grantsRole: 'member' }));
  // Default: neither username nor email exists.
  mockUserExists.mockReturnValue(existsResolving(null));
});

describe('UserAdminService.createUser', () => {
  const base = { username: 'NewUser', email: 'New@Example.com', password: 'Password1' };

  it('creates an org-less, pre-verified user (normalizes username/email; no membership)', async () => {
    const result = await userAdminService.createUser(base);

    // username/email normalized to trimmed-lowercase on the built user.
    expect(lastUser.username).toBe('newuser');
    expect(lastUser.email).toBe('new@example.com');
    expect(lastUser.isEmailVerified).toBe(true);
    expect(lastUser.isSuperAdmin).toBe(false);
    // No org → no membership write, no lastActiveOrgId.
    expect(mockUserOrgCreate).not.toHaveBeenCalled();
    expect(lastUser.lastActiveOrgId).toBeUndefined();
    expect(mockUserSave).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      id: 'user-1',
      username: 'newuser',
      email: 'new@example.com',
      isSuperAdmin: false,
      isEmailVerified: true,
    });
    expect(result.organizationId).toBeUndefined();
    expect(result.role).toBeUndefined();
  });

  it('assigns the user to an existing org with the given role', async () => {
    mockOrgFindById.mockReturnValue(findByIdResolving({ _id: 'org-9' }));

    const result = await userAdminService.createUser({ ...base, organizationId: 'org-9', role: 'admin' });

    expect(mockUserOrgCreate).toHaveBeenCalledTimes(1);
    const membership = (mockUserOrgCreate.mock.calls[0] as any)[0][0];
    expect(membership).toMatchObject({ organizationId: 'org-9', role: 'admin' });
    expect(lastUser.lastActiveOrgId).toBe('org-9');
    expect(result.organizationId).toBe('org-9');
    expect(result.role).toBe('admin');
  });

  it('defaults the membership role to member when an org is given without a role', async () => {
    mockOrgFindById.mockReturnValue(findByIdResolving({ _id: 'org-9' }));

    const result = await userAdminService.createUser({ ...base, organizationId: 'org-9' });

    expect((mockUserOrgCreate.mock.calls[0] as any)[0][0].role).toBe('member');
    expect(result.role).toBe('member');
  });

  it('gives an admin-created member the Member floor and NO Admin Role (member perms only)', async () => {
    mockOrgFindById.mockReturnValue(findByIdResolving({ _id: 'org-9' }));

    await userAdminService.createUser({ ...base, organizationId: 'org-9', role: 'member' });

    expect(mockEnsureBaselineRole).toHaveBeenCalledTimes(1);
    expect(mockAssignBuiltinAdminRole).not.toHaveBeenCalled();
  });

  it('grants an admin (no roleIds) the built-in Admin Role so their PERMISSIONS match the coarse role', async () => {
    mockOrgFindById.mockReturnValue(findByIdResolving({ _id: 'org-9' }));

    await userAdminService.createUser({ ...base, organizationId: 'org-9', role: 'admin' });

    // Member floor + Admin Role are both assigned THROUGH Role assignment, then
    // recompute derives the coarse role (no manual membership.role split-brain).
    expect(mockEnsureBaselineRole).toHaveBeenCalledTimes(1);
    expect(mockAssignBuiltinAdminRole).toHaveBeenCalledTimes(1);
    expect((mockAssignBuiltinAdminRole.mock.calls[0] as any)[1]).toBe('org-9');
    expect(mockRecomputeUserOrgRole).toHaveBeenCalled();
  });

  it('grants an owner the built-in Admin Role too (owner == admin bundle)', async () => {
    mockOrgFindById.mockReturnValue(findByIdResolving({ _id: 'org-9' }));

    await userAdminService.createUser({ ...base, organizationId: 'org-9', role: 'owner' });

    expect(mockAssignBuiltinAdminRole).toHaveBeenCalledTimes(1);
    // The membership is still created as 'owner' so recompute preserves the label.
    expect((mockUserOrgCreate.mock.calls[0] as any)[0][0].role).toBe('owner');
  });

  it('honors the isSuperAdmin flag', async () => {
    const result = await userAdminService.createUser({ ...base, isSuperAdmin: true });
    expect(lastUser.isSuperAdmin).toBe(true);
    expect(result.isSuperAdmin).toBe(true);
  });

  it('throws UA_USERNAME_TAKEN when the username exists (no user built)', async () => {
    mockUserExists.mockReturnValueOnce(existsResolving({ _id: 'dupe' }));

    await expect(userAdminService.createUser(base)).rejects.toThrow(UA_USERNAME_TAKEN);
    expect(lastUser).toBeUndefined();
    expect(mockUserSave).not.toHaveBeenCalled();
  });

  it('throws UA_EMAIL_TAKEN when the email exists (username free)', async () => {
    // First check (username) → free; second check (email) → taken.
    mockUserExists
      .mockReturnValueOnce(existsResolving(null))
      .mockReturnValueOnce(existsResolving({ _id: 'dupe' }));

    await expect(userAdminService.createUser(base)).rejects.toThrow(UA_EMAIL_TAKEN);
    expect(mockUserSave).not.toHaveBeenCalled();
  });

  it('throws UA_ORG_NOT_FOUND when the target org is missing (user not saved)', async () => {
    mockOrgFindById.mockReturnValue(findByIdResolving(null));

    await expect(userAdminService.createUser({ ...base, organizationId: 'ghost' }))
      .rejects.toThrow(UA_ORG_NOT_FOUND);
    expect(mockUserOrgCreate).not.toHaveBeenCalled();
    expect(mockUserSave).not.toHaveBeenCalled();
  });

  it('upserts a RoleAssignment per roleId then recomputes the org role ONCE', async () => {
    mockOrgFindById.mockReturnValue(findByIdResolving({ _id: 'org-9' }));

    await userAdminService.createUser({ ...base, organizationId: 'org-9', roleIds: ['g1', 'g2'] });

    // Each role is looked up (scoped to the org) and upserted; user saved first.
    expect(mockUserSave).toHaveBeenCalledTimes(1);
    expect(mockGroupFindOne).toHaveBeenCalledTimes(2);
    expect(mockGroupMembershipUpdateOne).toHaveBeenCalledTimes(2);
    expect((mockGroupMembershipUpdateOne.mock.calls[0] as any)[0]).toMatchObject({ roleId: 'g1' });
    expect((mockGroupMembershipUpdateOne.mock.calls[1] as any)[0]).toMatchObject({ roleId: 'g2' });
    // Role derivation is delegated to recomputeUserOrgRole — called exactly once.
    expect(mockRecomputeUserOrgRole).toHaveBeenCalledTimes(1);
    expect((mockRecomputeUserOrgRole.mock.calls[0] as any)[1]).toBe('org-9');
  });

  it('throws UA_ROLES_NEED_ORG when roleIds are given without an org (no DB work)', async () => {
    await expect(userAdminService.createUser({ ...base, roleIds: ['g1'] }))
      .rejects.toThrow(UA_ROLES_NEED_ORG);
    expect(lastUser).toBeUndefined();
    expect(mockUserSave).not.toHaveBeenCalled();
    expect(mockGroupMembershipUpdateOne).not.toHaveBeenCalled();
  });

  it('throws RL_ROLE_NOT_FOUND for an unknown role (no recompute)', async () => {
    mockOrgFindById.mockReturnValue(findByIdResolving({ _id: 'org-9' }));
    mockGroupFindOne.mockReturnValue(findByIdResolving(null));

    await expect(userAdminService.createUser({ ...base, organizationId: 'org-9', roleIds: ['ghost'] }))
      .rejects.toThrow(RL_ROLE_NOT_FOUND);
    expect(mockGroupMembershipUpdateOne).not.toHaveBeenCalled();
    expect(mockRecomputeUserOrgRole).not.toHaveBeenCalled();
  });
});
