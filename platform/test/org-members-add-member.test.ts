// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for OrgMembersService.addMember — specifically the single-source
 * RBAC Role assignment.
 *
 * Under single-source RBAC a user's permissions come ONLY from assigned Roles.
 * Setting `UserOrganization.role='admin'` alone leaves the user with
 * coarse-admin / ZERO permissions, so a direct admin add must ALSO grant the
 * built-in Admin Role (via assignBuiltinAdminRole + recompute). A plain member
 * add gets only the Member floor. These tests assert that orchestration with the
 * model + roles-service layers mocked.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUoCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUoExists = jest.fn<(...a: unknown[]) => unknown>();
const mockEnsureBaselineRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAssignBuiltinAdminRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRecomputeUserOrgRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class { constructor(public id: string) {} } } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope: async (id: string) => [id] }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  seatCapacityAvailable: jest.fn(async () => true),
  seatCapacityStillWithinCap: jest.fn(async () => true),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  ensureBaselineRole: (...a: unknown[]) => mockEnsureBaselineRole(...a),
  assignBuiltinAdminRole: (...a: unknown[]) => mockAssignBuiltinAdminRole(...a),
  recomputeUserOrgRole: (...a: unknown[]) => mockRecomputeUserOrgRole(...a),
}));

// Run the transaction body inline with a fake session (no live Mongo).
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  User: {
    findById: (...a: unknown[]) => mockUserFindById(...a),
    findOne: (...a: unknown[]) => mockUserFindOne(...a),
  },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUoFindOne(...a),
    create: (...a: unknown[]) => mockUoCreate(...a),
    exists: (...a: unknown[]) => mockUoExists(...a),
  },
  RoleAssignment: {},
}));

const { orgMembersService, OM_USER_NOT_FOUND, OM_ALREADY_MEMBER } =
  await import('../src/services/org-members-service.js');

/** `X.findOne(...)/findById(...)` returns a query whose `.session()` resolves to `doc`. */
const sessionResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgFindById.mockReturnValue(sessionResolving({ _id: 'org-1' }));
  mockUserFindById.mockReturnValue(sessionResolving({ _id: 'u1' }));
  mockUserFindOne.mockReturnValue(sessionResolving({ _id: 'u1' }));
  mockUoFindOne.mockReturnValue(sessionResolving(null)); // not already a member
  mockUoCreate.mockResolvedValue([{ _id: 'membership' }]);
  mockUoExists.mockReturnValue(sessionResolving(null)); // holds no seat yet
  mockEnsureBaselineRole.mockResolvedValue(undefined);
  mockAssignBuiltinAdminRole.mockResolvedValue(true);
  mockRecomputeUserOrgRole.mockResolvedValue(undefined);
});

describe('OrgMembersService.addMember', () => {
  it('gives a plain member the Member floor and NO Admin Role', async () => {
    await orgMembersService.addMember('org-1', { userId: 'u1', role: 'member' });

    expect(mockUoCreate).toHaveBeenCalledTimes(1);
    expect((mockUoCreate.mock.calls[0] as any)[0][0]).toMatchObject({ role: 'member' });
    expect(mockEnsureBaselineRole).toHaveBeenCalledTimes(1);
    expect(mockAssignBuiltinAdminRole).not.toHaveBeenCalled();
  });

  it('defaults to member (Member floor only) when no role is supplied', async () => {
    await orgMembersService.addMember('org-1', { userId: 'u1' });

    expect((mockUoCreate.mock.calls[0] as any)[0][0]).toMatchObject({ role: 'member' });
    expect(mockEnsureBaselineRole).toHaveBeenCalledTimes(1);
    expect(mockAssignBuiltinAdminRole).not.toHaveBeenCalled();
  });

  it('grants an admin the built-in Admin Role so their PERMISSIONS match the coarse role', async () => {
    await orgMembersService.addMember('org-1', { userId: 'u1', role: 'admin' });

    // Member floor + Admin Role both assigned through Role assignment, then a
    // recompute derives the cached coarse role (no manual membership.role split-brain).
    expect(mockEnsureBaselineRole).toHaveBeenCalledTimes(1);
    expect(mockAssignBuiltinAdminRole).toHaveBeenCalledTimes(1);
    expect((mockAssignBuiltinAdminRole.mock.calls[0] as any)[0]).toBe('u1');
    expect((mockAssignBuiltinAdminRole.mock.calls[0] as any)[1]).toBe('org-1');
    expect(mockRecomputeUserOrgRole).toHaveBeenCalledTimes(1);
  });

  it('does not assign any Role when the user is already a member', async () => {
    mockUoFindOne.mockReturnValue(sessionResolving({ _id: 'existing' }));

    await expect(orgMembersService.addMember('org-1', { userId: 'u1', role: 'admin' }))
      .rejects.toThrow(OM_ALREADY_MEMBER);

    expect(mockUoCreate).not.toHaveBeenCalled();
    expect(mockAssignBuiltinAdminRole).not.toHaveBeenCalled();
    expect(mockEnsureBaselineRole).not.toHaveBeenCalled();
  });

  it('does not assign any Role when the user does not exist', async () => {
    mockUserFindById.mockReturnValue(sessionResolving(null));

    await expect(orgMembersService.addMember('org-1', { userId: 'ghost', role: 'admin' }))
      .rejects.toThrow(OM_USER_NOT_FOUND);

    expect(mockAssignBuiltinAdminRole).not.toHaveBeenCalled();
  });
});
