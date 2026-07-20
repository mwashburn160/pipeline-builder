// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Representative bump-site test: a privilege change that bumps `tokenVersion`
 * must PUBLISH the user's new version to the stateless services after the
 * transaction commits. We use OrgMembersService.removeMember and assert it calls
 * `publishUserRevocation(userId)` (the session-revocation helper is mocked so we
 * assert the call, not the Redis write — that's covered in session-revocation.test).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUoDeleteOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPublishUser = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockPublishUsers = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);

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

// The publisher under assertion — mocked so we verify the call, not the Redis I/O.
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: (...a: unknown[]) => mockPublishUser(...a),
  publishUsersRevocation: (...a: unknown[]) => mockPublishUsers(...a),
}));

jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: jest.fn() },
  User: { updateOne: (...a: unknown[]) => mockUserUpdateOne(...a) },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUoFindOne(...a),
    deleteOne: (...a: unknown[]) => mockUoDeleteOne(...a),
  },
  RoleAssignment: {},
}));

const { orgMembersService } = await import('../src/services/org-members-service.js');

const findOneResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateOne.mockResolvedValue(undefined);
  mockUoDeleteOne.mockReturnValue({ session: () => Promise.resolve(undefined) });
});

describe('OrgMembersService.removeMember → session-revocation publish', () => {
  it('publishes the removed user tokenVersion after the transaction', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving({ _id: 'm1', role: 'member' }));

    await orgMembersService.removeMember('org-1', 'user-1');

    // The bump write happened...
    const bump = mockUserUpdateOne.mock.calls.find((c) => (c[1] as any)?.$inc?.tokenVersion === 1);
    expect(bump).toBeDefined();
    // ...and the publisher was invoked for that user.
    expect(mockPublishUser).toHaveBeenCalledTimes(1);
    expect(mockPublishUser).toHaveBeenCalledWith('user-1');
  });

  it('does not publish when the member is missing (no bump)', async () => {
    mockUoFindOne.mockReturnValue(findOneResolving(null));
    await expect(orgMembersService.removeMember('org-1', 'ghost')).rejects.toThrow();
    expect(mockPublishUser).not.toHaveBeenCalled();
  });
});
