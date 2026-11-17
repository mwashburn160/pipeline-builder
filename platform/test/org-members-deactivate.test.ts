// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for OrgMembersService.deactivateMember.
 *
 * The security-critical behavior: deactivating a member must end their access
 * to THIS org immediately. `requireAuth` trusts the JWT claims and only re-reads
 * the access version (never `isActive`), so a soft-deactivate that flips
 * `isActive:false` alone would leave a deactivated member with full read+write
 * access until their access token expired. deactivateMember therefore bumps
 * `User.claimsVersion` in the same transaction — and ONLY that: their sessions
 * span every org they belong to, so one org must not sign them out globally
 * (the SCIM `endOrgAccess` scoping). It also runs the same Role-unassign guards
 * as removing them (a delegate can't deactivate an admin).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { seatsMock } from './helpers/seats-mock.js';

const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockMembershipSave = jest.fn<(...a: unknown[]) => Promise<unknown>>();

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
const mockStripGuard = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/role-crud.js', () => ({ assertActorMayStripMemberRoles: (...a: unknown[]) => mockStripGuard(...a) }));
jest.unstable_mockModule('../src/helpers/account-membership.js', () => ({ assertDirectAddConsented: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ assertActorMayAssignBuiltinAdmin: async () => undefined, ensureBaselineRole: jest.fn(async () => undefined), assignBuiltinAdminRole: jest.fn(async () => true), recomputeUserOrgRole: jest.fn(async () => undefined) }));

// Run the transaction body inline with a fake session (no live Mongo).
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: { findById: jest.fn() },
  User: { updateOne: (...a: unknown[]) => mockUserUpdateOne(...a) },
  UserOrganization: { findOne: (...a: unknown[]) => mockUoFindOne(...a) },
  // Named import in org-members-service (listMembers-only, untested here); ESM
  // linking still requires the export to exist on the mock.
  RoleAssignment: {},
}));

const { orgMembersService } = await import('../src/services/org-members-service.js');
const { OM_MEMBERSHIP_NOT_FOUND, OM_CANNOT_REMOVE_OWNER, OM_ALREADY_INACTIVE } = await import('../src/services/org-members-errors.js');

/** `UserOrganization.findOne(...)` returns a query whose `.session()` resolves to `doc`. */
const findOneResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

const ADMIN = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateOne.mockResolvedValue(undefined);
  mockMembershipSave.mockResolvedValue(undefined);
  mockStripGuard.mockResolvedValue({ heldSuperadmin: false });
});

describe('OrgMembersService.deactivateMember', () => {
  it('bumps claimsVersion ONLY — no tokenVersion bump, no refresh-session wipe (org-scoped revocation)', async () => {
    const membership = { role: 'member', isActive: true, save: mockMembershipSave };
    mockUoFindOne.mockReturnValue(findOneResolving(membership));

    await orgMembersService.deactivateMember('org-1', 'user-1', ADMIN);

    // Membership is soft-deactivated.
    expect(membership.isActive).toBe(false);
    expect(mockMembershipSave).toHaveBeenCalled();

    // Outstanding access tokens go stale on the next request...
    const invalidation = mockUserUpdateOne.mock.calls.find(
      (c) => (c[1] as any)?.$inc?.claimsVersion === 1,
    );
    expect(invalidation).toBeDefined();
    expect((invalidation![0] as any)).toEqual({ _id: 'user-1' });
    // ...but the person's sessions (which span their OTHER orgs) survive. This
    // was a repeatable cross-tenant forced sign-out.
    for (const [, update] of mockUserUpdateOne.mock.calls) {
      expect((update as any)?.$inc?.tokenVersion).toBeUndefined();
      expect((update as any)?.$set?.refreshSessions).toBeUndefined();
    }
  });

  it('runs the Role-unassign guards with the actor before deactivating — a refusal writes nothing', async () => {
    const membership = { role: 'admin', isActive: true, save: mockMembershipSave };
    mockUoFindOne.mockReturnValue(findOneResolving(membership));
    const delegate = { isSuperAdmin: false, isOrgAdmin: false, permissions: ['members:manage'] };
    mockStripGuard.mockRejectedValue(new Error('RL_ASSIGN_EXCEEDS_CEILING'));

    await expect(orgMembersService.deactivateMember('org-1', 'admin-1', delegate)).rejects.toThrow('RL_ASSIGN_EXCEEDS_CEILING');

    expect(mockStripGuard).toHaveBeenCalledWith('org-1', 'admin-1', delegate, expect.anything());
    expect(membership.isActive).toBe(true);
    expect(mockMembershipSave).not.toHaveBeenCalled();
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('clears lastActiveOrgId when it pointed at the deactivated org', async () => {
    const membership = { role: 'member', isActive: true, save: mockMembershipSave };
    mockUoFindOne.mockReturnValue(findOneResolving(membership));

    await orgMembersService.deactivateMember('org-1', 'user-1', ADMIN);

    const lastActiveClear = mockUserUpdateOne.mock.calls.find(
      (c) => (c[0] as any)?.lastActiveOrgId !== undefined,
    );
    expect(lastActiveClear).toBeDefined();
    expect((lastActiveClear![1] as any).$unset).toHaveProperty('lastActiveOrgId');
  });

  it('refuses to deactivate the owner (no token bump)', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ role: 'owner', isActive: true, save: mockMembershipSave }));
    await expect(orgMembersService.deactivateMember('org-1', 'owner-1', ADMIN)).rejects.toThrow(OM_CANNOT_REMOVE_OWNER);
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('throws when the membership is missing', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving(null));
    await expect(orgMembersService.deactivateMember('org-1', 'ghost', ADMIN)).rejects.toThrow(OM_MEMBERSHIP_NOT_FOUND);
  });

  it('throws when already inactive (no token bump)', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ role: 'member', isActive: false, save: mockMembershipSave }));
    await expect(orgMembersService.deactivateMember('org-1', 'user-1', ADMIN)).rejects.toThrow(OM_ALREADY_INACTIVE);
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });
});
