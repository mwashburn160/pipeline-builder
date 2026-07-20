// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for OrgMembersService.transferOwnership.
 *
 * The security-critical behavior: swapping ownership (owner ↔ admin) must
 * INVALIDATE both users' live sessions immediately. The membership `role` is
 * baked into the JWT at issue time, so without a `tokenVersion` bump the demoted
 * ex-owner would keep an owner-role token (~2 h) and the new owner's elevation
 * wouldn't take effect until refresh. transferOwnership therefore bumps BOTH
 * users' `tokenVersion` in the same transaction — mirroring removeMember /
 * updateRole.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserUpdateMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();

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
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: jest.fn(async () => undefined) }));

// Run the transaction body inline with a fake session (no live Mongo).
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  User: { updateMany: (...a: unknown[]) => mockUserUpdateMany(...a) },
  UserOrganization: { findOne: (...a: unknown[]) => mockUoFindOne(...a) },
  RoleAssignment: {},
}));

const {
  orgMembersService,
  OM_ORG_NOT_FOUND,
  OM_OWNER_MEMBERSHIP_NOT_FOUND,
  OM_NEW_OWNER_MUST_BE_MEMBER,
} = await import('../src/services/org-members-service.js');

/** `X.findOne(...)/findById(...)` returns a query whose `.session()` resolves to `doc`. */
const sessionResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateMany.mockResolvedValue(undefined);
});

describe('OrgMembersService.transferOwnership', () => {
  it('swaps roles and bumps BOTH users tokenVersion (invalidating live sessions)', async () => {
    const orgDoc = { owner: 'old-owner', save: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) };
    const oldOwnerMembership = { userId: 'old-owner', role: 'owner', save: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) };
    const newOwnerMembership = { userId: 'new-owner', role: 'admin', save: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) };

    mockOrgFindById.mockReturnValue(sessionResolving(orgDoc));
    mockUoFindOne
      .mockReturnValueOnce(sessionResolving(oldOwnerMembership)) // current owner lookup
      .mockReturnValueOnce(sessionResolving(newOwnerMembership)); // new owner membership

    await orgMembersService.transferOwnership('org-1', 'new-owner');

    // Roles swapped + persisted.
    expect(oldOwnerMembership.role).toBe('admin');
    expect(newOwnerMembership.role).toBe('owner');
    expect(oldOwnerMembership.save).toHaveBeenCalled();
    expect(newOwnerMembership.save).toHaveBeenCalled();

    // Both users' tokens invalidated in one $inc, targeting old + new owner.
    const bump = mockUserUpdateMany.mock.calls.find((c) => (c[1] as any)?.$inc?.tokenVersion === 1);
    expect(bump).toBeDefined();
    expect((bump![0] as any)._id.$in).toEqual(['old-owner', 'new-owner']);
  });

  it('throws when the org does not exist (no token bump)', async () => {
    mockOrgFindById.mockReturnValue(sessionResolving(null));
    await expect(orgMembersService.transferOwnership('ghost', 'new-owner')).rejects.toThrow(OM_ORG_NOT_FOUND);
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  it('throws when no current owner membership exists (no token bump)', async () => {
    mockOrgFindById.mockReturnValue(sessionResolving({ owner: 'x', save: jest.fn() }));
    mockUoFindOne.mockReturnValueOnce(sessionResolving(null));
    await expect(orgMembersService.transferOwnership('org-1', 'new-owner')).rejects.toThrow(OM_OWNER_MEMBERSHIP_NOT_FOUND);
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  it('throws when the new owner is not a member (no token bump)', async () => {
    mockOrgFindById.mockReturnValue(sessionResolving({ owner: 'x', save: jest.fn() }));
    mockUoFindOne
      .mockReturnValueOnce(sessionResolving({ userId: 'old-owner', role: 'owner', save: jest.fn() }))
      .mockReturnValueOnce(sessionResolving(null));
    await expect(orgMembersService.transferOwnership('org-1', 'stranger')).rejects.toThrow(OM_NEW_OWNER_MUST_BE_MEMBER);
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });
});
