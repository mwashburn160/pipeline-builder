// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for UserAdminService.updateUserById's role-change path.
 *
 * Under single-source RBAC the coarse `UserOrganization.role` is DERIVED from a
 * user's assigned Roles. Setting `membership.role` directly (the retired
 * split-brain) gives coarse-admin with member-level permissions AND is reverted
 * by the next recompute. So a role change must be routed THROUGH Role
 * assignment: promote → grant the built-in Admin Role, demote → strip it, always
 * re-assert the Member floor, then let recompute derive the cached role + bump
 * tokenVersion. These tests assert that orchestration — not a manual
 * membership.role / tokenVersion write.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserSave = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAssignBuiltinAdminRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRemoveBuiltinAdminRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockEnsureBaselineRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRecomputeUserOrgRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('../src/helpers/active-org-info.js', () => ({
  loadActiveOrgInfo: jest.fn(async () => ({ organizationName: 'Acme', activeOrgRole: 'admin', tier: 'developer' })),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({ seatCapacityAvailable: jest.fn(async () => true) }));
jest.unstable_mockModule('../src/utils/regex.js', () => ({ escapeRegex: (s: string) => s }));

jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => Promise<unknown>) => fn({ id: 'sess' }),
}));

const RL_ROLE_NOT_FOUND = 'RL_ROLE_NOT_FOUND';
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  RL_ROLE_NOT_FOUND,
  recomputeUserOrgRole: (...a: unknown[]) => mockRecomputeUserOrgRole(...a),
  ensureBaselineRole: (...a: unknown[]) => mockEnsureBaselineRole(...a),
  assignBuiltinAdminRole: (...a: unknown[]) => mockAssignBuiltinAdminRole(...a),
  removeBuiltinAdminRole: (...a: unknown[]) => mockRemoveBuiltinAdminRole(...a),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: { findById: jest.fn() },
  UserOrganization: { findOne: (...a: unknown[]) => mockUoFindOne(...a), create: jest.fn(), deleteMany: jest.fn() },
  Role: { findOne: jest.fn() },
  RoleAssignment: { updateOne: jest.fn(), deleteMany: jest.fn() },
}));

const { userAdminService, UA_CANNOT_CHANGE_OWNER } = await import('../src/services/user-admin-service.js');

/** `User.findById(...)` → `.select(...).session(...)` resolving to `doc`. */
const userFindByIdResolving = (doc: unknown) => ({ select: () => ({ session: () => Promise.resolve(doc) }) });
/** `UserOrganization.findOne(...)` → `.session(...)` resolving to `doc`. */
const uoFindOneResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

const orgAdminOpts = { isOrgAdmin: true, adminOrgId: 'org-1', passwordMinLength: 8 };

beforeEach(() => {
  jest.clearAllMocks();
  mockUserSave.mockResolvedValue(undefined);
  mockEnsureBaselineRole.mockResolvedValue(undefined);
  mockRecomputeUserOrgRole.mockResolvedValue(undefined);
  mockAssignBuiltinAdminRole.mockResolvedValue(true);
  mockRemoveBuiltinAdminRole.mockResolvedValue(undefined);
});

describe('UserAdminService.updateUserById — role change', () => {
  it('promote to admin assigns the built-in Admin Role (real permissions), not a manual coarse label', async () => {
    const user: any = { _id: 'u1', tokenVersion: 3, save: mockUserSave, lastActiveOrgId: 'org-1' };
    mockUserFindById.mockReturnValue(userFindByIdResolving(user));
    const membership: any = { role: 'member', save: jest.fn() };
    mockUoFindOne.mockReturnValue(uoFindOneResolving(membership));

    const { changes } = await userAdminService.updateUserById('u1', { role: 'admin' }, orgAdminOpts);

    // Admin Role assigned + Member floor re-asserted; recompute derives the role.
    expect(mockAssignBuiltinAdminRole).toHaveBeenCalledTimes(1);
    expect((mockAssignBuiltinAdminRole.mock.calls[0] as any)[1]).toBe('org-1');
    expect(mockRemoveBuiltinAdminRole).not.toHaveBeenCalled();
    expect(mockEnsureBaselineRole).toHaveBeenCalledTimes(1);

    // No split-brain: the coarse membership.role is NOT set directly here, and
    // tokenVersion is NOT hand-bumped (recompute owns both).
    expect(membership.save).not.toHaveBeenCalled();
    expect(membership.role).toBe('member');
    expect(user.tokenVersion).toBe(3);
    expect(changes).toContain('role');
  });

  it('demote to member strips the Admin Role but keeps the Member floor', async () => {
    const user: any = { _id: 'u1', tokenVersion: 1, save: mockUserSave, lastActiveOrgId: 'org-1' };
    mockUserFindById.mockReturnValue(userFindByIdResolving(user));
    mockUoFindOne.mockReturnValue(uoFindOneResolving({ role: 'admin', save: jest.fn() }));

    await userAdminService.updateUserById('u1', { role: 'member' }, orgAdminOpts);

    expect(mockRemoveBuiltinAdminRole).toHaveBeenCalledTimes(1);
    expect(mockAssignBuiltinAdminRole).not.toHaveBeenCalled();
    expect(mockEnsureBaselineRole).toHaveBeenCalledTimes(1);
  });

  it('refuses to change an owner membership (UA_CANNOT_CHANGE_OWNER)', async () => {
    const user: any = { _id: 'u1', tokenVersion: 1, save: mockUserSave, lastActiveOrgId: 'org-1' };
    mockUserFindById.mockReturnValue(userFindByIdResolving(user));
    mockUoFindOne.mockReturnValue(uoFindOneResolving({ role: 'owner', save: jest.fn() }));

    await expect(userAdminService.updateUserById('u1', { role: 'admin' }, orgAdminOpts))
      .rejects.toThrow(UA_CANNOT_CHANGE_OWNER);
    expect(mockAssignBuiltinAdminRole).not.toHaveBeenCalled();
  });

  it('is a no-op when the role is unchanged (no Role writes)', async () => {
    const user: any = { _id: 'u1', tokenVersion: 1, save: mockUserSave, lastActiveOrgId: 'org-1' };
    mockUserFindById.mockReturnValue(userFindByIdResolving(user));
    mockUoFindOne.mockReturnValue(uoFindOneResolving({ role: 'admin', save: jest.fn() }));

    const { changes } = await userAdminService.updateUserById('u1', { role: 'admin' }, orgAdminOpts);

    expect(mockAssignBuiltinAdminRole).not.toHaveBeenCalled();
    expect(mockRemoveBuiltinAdminRole).not.toHaveBeenCalled();
    expect(mockEnsureBaselineRole).not.toHaveBeenCalled();
    expect(changes).not.toContain('role');
  });
});
