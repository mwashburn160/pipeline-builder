// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for OrgMembersService.deactivateMember.
 *
 * The security-critical behavior: deactivating a member must INVALIDATE their
 * live sessions immediately. `requireAuth` trusts the JWT claims and only
 * re-reads `tokenVersion` (never `isActive`), so a soft-deactivate that flips
 * `isActive:false` alone would leave a deactivated member with full read+write
 * access until their access token expired. deactivateMember therefore bumps
 * `User.tokenVersion` and clears the refresh token in the same transaction —
 * mirroring removeMember.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockMembershipSave = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope: async (id: string) => [id] }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  seatCapacityAvailable: jest.fn(async () => true),
  seatCapacityStillWithinCap: jest.fn(async () => true),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: jest.fn(async () => undefined) }));

// Run the transaction body inline with a fake session (no live Mongo).
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: jest.fn() },
  User: { updateOne: (...a: unknown[]) => mockUserUpdateOne(...a) },
  UserOrganization: { findOne: (...a: unknown[]) => mockUoFindOne(...a) },
  // Named import in org-members-service (listMembers-only, untested here); ESM
  // linking still requires the export to exist on the mock.
  RoleAssignment: {},
}));

const { orgMembersService, OM_MEMBERSHIP_NOT_FOUND, OM_CANNOT_REMOVE_OWNER, OM_ALREADY_INACTIVE } =
  await import('../src/services/org-members-service.js');

/** `UserOrganization.findOne(...)` returns a query whose `.session()` resolves to `doc`. */
const findOneResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateOne.mockResolvedValue(undefined);
  mockMembershipSave.mockResolvedValue(undefined);
});

describe('OrgMembersService.deactivateMember', () => {
  it('bumps tokenVersion + clears the refresh token (invalidating live sessions)', async () => {
    const membership = { role: 'member', isActive: true, save: mockMembershipSave };
    mockUoFindOne.mockReturnValue(findOneResolving(membership));

    await orgMembersService.deactivateMember('org-1', 'user-1');

    // Membership is soft-deactivated.
    expect(membership.isActive).toBe(false);
    expect(mockMembershipSave).toHaveBeenCalled();

    // The token-invalidation write: $inc tokenVersion + $unset refreshToken,
    // targeted at the user (no lastActiveOrgId filter on this write).
    const invalidation = mockUserUpdateOne.mock.calls.find(
      (c) => (c[1] as any)?.$inc?.tokenVersion === 1,
    );
    expect(invalidation).toBeDefined();
    expect((invalidation![0] as any)).toEqual({ _id: 'user-1' });
    expect((invalidation![1] as any).$unset).toHaveProperty('refreshToken');
  });

  it('clears lastActiveOrgId when it pointed at the deactivated org', async () => {
    const membership = { role: 'member', isActive: true, save: mockMembershipSave };
    mockUoFindOne.mockReturnValue(findOneResolving(membership));

    await orgMembersService.deactivateMember('org-1', 'user-1');

    const lastActiveClear = mockUserUpdateOne.mock.calls.find(
      (c) => (c[0] as any)?.lastActiveOrgId !== undefined,
    );
    expect(lastActiveClear).toBeDefined();
    expect((lastActiveClear![1] as any).$unset).toHaveProperty('lastActiveOrgId');
  });

  it('refuses to deactivate the owner (no token bump)', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ role: 'owner', isActive: true, save: mockMembershipSave }));
    await expect(orgMembersService.deactivateMember('org-1', 'owner-1')).rejects.toThrow(OM_CANNOT_REMOVE_OWNER);
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('throws when the membership is missing', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving(null));
    await expect(orgMembersService.deactivateMember('org-1', 'ghost')).rejects.toThrow(OM_MEMBERSHIP_NOT_FOUND);
  });

  it('throws when already inactive (no token bump)', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ role: 'member', isActive: false, save: mockMembershipSave }));
    await expect(orgMembersService.deactivateMember('org-1', 'user-1')).rejects.toThrow(OM_ALREADY_INACTIVE);
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });
});
