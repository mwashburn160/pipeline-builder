// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `deleteUserCascade` — the one cascade behind self-serve and admin account
 * deletion. Unit-level pins (the real-Mongo behavior is covered by
 * user-cascade.integration.test.ts):
 *   - every write runs in the caller's session;
 *   - the user's domain-join requests go with the account (a leftover request
 *     could be approved into an orphan membership holding a seat);
 *   - their passkeys go too (a leftover credential keeps its unique id reserved);
 *   - the owner and last-privileged-member guards run BEFORE anything is deleted.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';

const session = { id: 'tx' };
const calls: string[] = [];
const deleteMany = (name: string) => jest.fn(async (_filter: unknown, opts: { session?: unknown }) => {
  calls.push(`${name}:${opts?.session === session ? 'tx' : 'NO-SESSION'}`);
  return { deletedCount: 1 };
});
const mockOwnerCount = jest.fn<() => Promise<number>>();
const mockFindByIdAndDelete = jest.fn<() => { select: () => Promise<unknown> }>();
const mockAssertNotLast = jest.fn<(...a: unknown[]) => Promise<void>>();

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findByIdAndDelete: (...a: unknown[]) => { calls.push('User'); return mockFindByIdAndDelete(...(a as [])); } },
  UserOrganization: { countDocuments: () => ({ session: () => mockOwnerCount() }), deleteMany: deleteMany('UserOrganization') },
  RoleAssignment: { deleteMany: deleteMany('RoleAssignment') },
  PersonalAccessToken: { deleteMany: deleteMany('PersonalAccessToken') },
  UserPreferences: { deleteMany: deleteMany('UserPreferences') },
  JoinRequest: { deleteMany: deleteMany('JoinRequest') },
  WebAuthnCredential: { deleteMany: deleteMany('WebAuthnCredential') },
  UserTotp: { deleteMany: deleteMany('UserTotp') },
  MfaRecoveryCodes: { deleteMany: deleteMany('MfaRecoveryCodes') },
  MfaResetRequest: { deleteMany: deleteMany('MfaResetRequest') },
}));
jest.unstable_mockModule('../src/services/role-crud.js', () => ({
  assertNotLastPrivilegedMember: (...a: unknown[]) => mockAssertNotLast(...a),
}));

const { deleteUserCascade } = await import('../src/services/user-cascade.js');
const { USER_OWNER_HAS_ORGS } = await import('../src/services/user-errors.js');

const userId = new Types.ObjectId().toString();

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
  mockOwnerCount.mockResolvedValue(0);
  mockAssertNotLast.mockResolvedValue();
  mockFindByIdAndDelete.mockReturnValue({ select: async () => ({ tokenVersion: 4 }) });
});

describe('deleteUserCascade', () => {
  it('deletes the account and everything keyed to it — join requests included — in the session', async () => {
    await expect(deleteUserCascade(session as never, userId)).resolves.toEqual({ tokenVersion: 4 });
    expect(calls).toEqual(expect.arrayContaining([
      'UserOrganization:tx', 'RoleAssignment:tx', 'PersonalAccessToken:tx', 'WebAuthnCredential:tx',
      'UserPreferences:tx', 'JoinRequest:tx',
    ]));
    expect(mockAssertNotLast).toHaveBeenCalledWith(session, expect.any(Types.ObjectId));
  });

  it('refuses an org owner before deleting anything', async () => {
    mockOwnerCount.mockResolvedValue(1);
    await expect(deleteUserCascade(session as never, userId)).rejects.toThrow(USER_OWNER_HAS_ORGS);
    expect(calls).toEqual([]);
  });

  it('refuses the last member of a privileged Role before deleting anything', async () => {
    mockAssertNotLast.mockRejectedValue(new Error('RL_LAST_PRIVILEGED_MEMBER'));
    await expect(deleteUserCascade(session as never, userId)).rejects.toThrow('RL_LAST_PRIVILEGED_MEMBER');
    expect(calls).toEqual([]);
  });

  it('returns null (and cascades nothing) when the user is already gone', async () => {
    mockFindByIdAndDelete.mockReturnValue({ select: async () => null });
    await expect(deleteUserCascade(session as never, userId)).resolves.toBeNull();
    expect(calls).toEqual(['User']);
  });
});
