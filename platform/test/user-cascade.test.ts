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
 *   - the owner and last-privileged-member guards run BEFORE anything is deleted;
 *   - the GDPR erasure leg for OTHER services is enqueued in the same session.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';

const session = { id: 'tx' };
const calls: string[] = [];
const deleteMany = (name: string) => jest.fn(async (_filter: unknown, opts: { session?: unknown }) => {
  calls.push(`${name}:${opts?.session === session ? 'tx' : 'NO-SESSION'}`);
  return { deletedCount: 1 };
});
/** Owner memberships the user holds, and which of those orgs are already soft-deleted. */
let ownedOrgIds: string[] = [];
let deletedOrgIds: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chain = (rows: () => unknown[]) => { const c: any = { select: () => c, session: () => c, lean: async () => rows() }; return c; };
const mockFindByIdAndDelete = jest.fn<() => { select: () => Promise<unknown> }>();
const mockAssertNotLast = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockSamlDeleteFilter = jest.fn();

// Slots live in their own collection behind session-store.ts.
const { sessionStoreFake } = await import('./helpers/session-store-fake.js');
const store = sessionStoreFake();
jest.unstable_mockModule('../src/services/session/session-store.js', () => store);
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findByIdAndDelete: (...a: unknown[]) => { calls.push('User'); return mockFindByIdAndDelete(...(a as [])); } },
  UserOrganization: { find: () => chain(() => ownedOrgIds.map((organizationId) => ({ organizationId }))), deleteMany: deleteMany('UserOrganization') },
  Organization: { find: () => chain(() => deletedOrgIds.map((_id) => ({ _id }))) },
  PasswordResetToken: { deleteMany: deleteMany('PasswordResetToken') },
  RoleAssignment: { deleteMany: deleteMany('RoleAssignment') },
  PersonalAccessToken: { deleteMany: deleteMany('PersonalAccessToken') },
  UserPreferences: { deleteMany: deleteMany('UserPreferences') },
  JoinRequest: { deleteMany: deleteMany('JoinRequest') },
  WebAuthnCredential: { deleteMany: deleteMany('WebAuthnCredential') },
  UserTotp: { deleteMany: deleteMany('UserTotp') },
  PasswordLoginLockout: { deleteMany: deleteMany('PasswordLoginLockout') },
  MfaRecoveryCodes: { deleteMany: deleteMany('MfaRecoveryCodes') },
  MfaResetRequest: { deleteMany: deleteMany('MfaResetRequest') },
}));
jest.unstable_mockModule('../src/models/saml-session.js', () => ({
  __esModule: true,
  default: { deleteMany: (...a: [unknown, { session?: unknown }]) => { mockSamlDeleteFilter(a[0]); return deleteMany('SamlSession')(...a); } },
}));
const mockEnqueue = jest.fn(async (..._a: unknown[]) => { calls.push('Outbox'); return ['plugin']; });
jest.unstable_mockModule('../src/services/cascade-outbox.js', () => ({
  enqueueCascade: (...a: unknown[]) => mockEnqueue(...a),
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
  ownedOrgIds = [];
  deletedOrgIds = [];
  mockAssertNotLast.mockResolvedValue();
  mockFindByIdAndDelete.mockReturnValue({ select: async () => ({ tokenVersion: 4 }) });
});

describe('deleteUserCascade', () => {
  it('deletes the account and everything keyed to it — join requests included — in the session', async () => {
    await expect(deleteUserCascade(session as never, userId)).resolves.toEqual({ accessVersion: 4 });
    expect(calls).toEqual(expect.arrayContaining([
      'UserOrganization:tx', 'RoleAssignment:tx', 'PersonalAccessToken:tx', 'WebAuthnCredential:tx',
      'UserPreferences:tx', 'JoinRequest:tx', 'SamlSession:tx', 'PasswordResetToken:tx',
    ]));
    // SAML SLO rows key the person by string id.
    expect(mockSamlDeleteFilter).toHaveBeenCalledWith({ userId: userId });
    // Every refresh-session slot (its own collection), inside the same transaction.
    expect(store.deleteAllSlots).toHaveBeenCalledWith(expect.any(Types.ObjectId), session);
    expect(mockAssertNotLast).toHaveBeenCalledWith(session, expect.any(Types.ObjectId), undefined, []);
  });

  it('enqueues the user-erasure outbox leg IN the deletion\'s transaction', async () => {
    await deleteUserCascade(session as never, userId);
    // Same session ⇒ the erasure marker commits with the deletion or not at all.
    expect(mockEnqueue).toHaveBeenCalledWith('user.erased', userId, session);
    // After the account is gone (a refused deletion enqueues nothing — below).
    expect(calls.indexOf('Outbox')).toBeGreaterThan(calls.indexOf('User'));
  });

  it('an owned org that is already soft-deleted does not block, and its Roles are exempt from the lockout guard', async () => {
    ownedOrgIds = ['org-gone'];
    deletedOrgIds = ['org-gone'];
    await expect(deleteUserCascade(session as never, userId)).resolves.toEqual({ accessVersion: 4 });
    expect(mockAssertNotLast).toHaveBeenCalledWith(session, expect.any(Types.ObjectId), undefined, ['org-gone']);
  });

  it('refuses an org owner before deleting anything', async () => {
    ownedOrgIds = ['org-live'];
    await expect(deleteUserCascade(session as never, userId)).rejects.toThrow(USER_OWNER_HAS_ORGS);
    expect(calls).toEqual([]);
    expect(mockEnqueue).not.toHaveBeenCalled();
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
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
