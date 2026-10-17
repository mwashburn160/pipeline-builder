// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for InvitationService.accept — specifically the single-source RBAC
 * Role assignment on acceptance.
 *
 * Under single-source RBAC a user's permissions come ONLY from assigned Roles, so
 * accepting an ADMIN invitation must grant the built-in Admin Role (otherwise the
 * new admin carries `role:admin` with ZERO permissions until the next backfill).
 * A member invitee gets only the Member floor. These tests mock the model +
 * roles-service layers and assert that orchestration.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { seatsMock } from './helpers/seats-mock.js';

const mockInvitationFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUoCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockEnsureBaselineRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAssignBuiltinAdminRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRecomputeUserOrgRole = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockSendInvitationAccepted = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ invitation: { expirationDays: 7, maxPendingPerOrg: 10 } }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/seats.js', () => seatsMock({ seatCapacityAvailable: jest.fn(async () => true), seatCapacityStillWithinCap: jest.fn(async () => true), userHasSeatInAccount: jest.fn(async () => false) }));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  ensureBaselineRole: (...a: unknown[]) => mockEnsureBaselineRole(...a),
  assignBuiltinAdminRole: (...a: unknown[]) => mockAssignBuiltinAdminRole(...a),
  recomputeUserOrgRole: (...a: unknown[]) => mockRecomputeUserOrgRole(...a),
}));
jest.unstable_mockModule('../src/utils/email.js', () => ({
  emailService: { sendInvitationAccepted: (...a: unknown[]) => mockSendInvitationAccepted(...a) },
}));

/**
 * Run the transaction body inline with a fake session (no live Mongo).
 *
 * `txAttempts` models what the real helper does: `session.withTransaction`
 * RETRIES transient errors by re-running the whole body. Default 1 — every test
 * below sees exactly the old single-pass behaviour — and the retry test raises
 * it to prove nothing fires once per attempt that should fire once per commit.
 */
let txAttempts = 1;
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: async (cb: (s: unknown) => unknown) => {
    let out: unknown;
    for (let i = 0; i < txAttempts; i += 1) out = await cb({ id: 'test-session' });
    return out;
  },
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Invitation: { findOne: (...a: unknown[]) => mockInvitationFindOne(...a) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUoFindOne(...a),
    create: (...a: unknown[]) => mockUoCreate(...a),
  },
}));

const { invitationService } = await import('../src/services/invitation-service.js');
const errors = await import('../src/services/invitation-errors.js');

/** `X.findOne(...)/findById(...)` returns a query whose `.session()` resolves to `doc`. */
const sessionResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

const INVITEE_EMAIL = 'invitee@example.com';

/** Build a fresh pending invitation doc with the given coarse role. */
function makeInvitation(role: 'admin' | 'member') {
  return {
    role,
    status: 'pending',
    email: INVITEE_EMAIL,
    organizationId: 'org-1',
    invitedBy: 'inviter-1',
    isExpired: () => false,
    canAcceptViaEmail: () => true,
    canAcceptViaOAuth: () => true,
    save: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  txAttempts = 1;
  mockOrgFindById.mockReturnValue(sessionResolving({ _id: 'org-1', name: 'Acme' }));
  mockUoFindOne.mockReturnValue(sessionResolving(null)); // not already a member
  mockUoCreate.mockResolvedValue([{ _id: 'membership' }]);
  mockEnsureBaselineRole.mockResolvedValue(undefined);
  mockAssignBuiltinAdminRole.mockResolvedValue(true);
  mockRecomputeUserOrgRole.mockResolvedValue(undefined);
  mockSendInvitationAccepted.mockResolvedValue(undefined);
  // User.findById is called twice: first the accepting user, then the inviter.
  mockUserFindById
    .mockReturnValueOnce(sessionResolving({ _id: 'u1', email: INVITEE_EMAIL, lastActiveOrgId: 'existing-org', save: jest.fn() }))
    .mockReturnValueOnce(sessionResolving({ _id: 'inviter-1', email: 'boss@example.com', username: 'boss' }));
});

describe('InvitationService.accept — RBAC Role assignment', () => {
  it('gives a member invitee the Member floor and NO Admin Role', async () => {
    mockInvitationFindOne.mockReturnValue(sessionResolving(makeInvitation('member')));

    await invitationService.accept('tok', 'u1');

    expect(mockUoCreate).toHaveBeenCalledTimes(1);
    expect((mockUoCreate.mock.calls[0] as any)[0][0]).toMatchObject({ role: 'member' });
    expect(mockEnsureBaselineRole).toHaveBeenCalledTimes(1);
    expect(mockAssignBuiltinAdminRole).not.toHaveBeenCalled();
  });

  it('grants an admin invitee the built-in Admin Role so their PERMISSIONS match the coarse role', async () => {
    mockInvitationFindOne.mockReturnValue(sessionResolving(makeInvitation('admin')));

    await invitationService.accept('tok', 'u1');

    // Membership created as admin; Member floor + Admin Role both assigned through
    // Role assignment, then a recompute derives the cached coarse role.
    expect((mockUoCreate.mock.calls[0] as any)[0][0]).toMatchObject({ role: 'admin' });
    expect(mockEnsureBaselineRole).toHaveBeenCalledTimes(1);
    expect(mockAssignBuiltinAdminRole).toHaveBeenCalledTimes(1);
    expect((mockAssignBuiltinAdminRole.mock.calls[0] as any)[1]).toBe('org-1');
    expect(mockRecomputeUserOrgRole).toHaveBeenCalledTimes(1);
  });
});

describe('InvitationService.accept — a soft-deleted org', () => {
  it('REFUSES an invitation into an org that was soft-deleted (inside its restore window)', async () => {
    mockInvitationFindOne.mockReturnValue(sessionResolving(makeInvitation('member')));
    mockOrgFindById.mockReturnValue(sessionResolving({ _id: 'org-1', name: 'Acme', deletedAt: new Date() }));

    await expect(invitationService.accept('tok', 'u1')).rejects.toThrow('INV_ORG_NOT_FOUND');
    expect(mockUoCreate).not.toHaveBeenCalled();
  });
});

describe('InvitationService.acceptForRegistration — signing up FROM an invitation', () => {
  /** A brand-new user, as authService.register has just saved it: no active org yet. */
  const newUser = () => ({ _id: 'new-u', email: INVITEE_EMAIL, username: 'newbie', lastActiveOrgId: undefined as string | undefined, save: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) });

  beforeEach(() => {
    // Only the inviter is looked up (the user is handed in, not fetched).
    mockUserFindById.mockReset();
    mockUserFindById.mockReturnValue(sessionResolving({ _id: 'inviter-1', email: 'boss@example.com', username: 'boss' }));
  });

  it('joins the INVITING org with the invited role, makes it active, and marks the invite accepted', async () => {
    const invitation = makeInvitation('admin');
    mockInvitationFindOne.mockReturnValue(sessionResolving(invitation));
    const user = newUser();

    const res = await invitationService.acceptForRegistration('tok', user as never, { id: 's' } as never);

    expect(mockUoCreate).toHaveBeenCalledTimes(1);
    expect((mockUoCreate.mock.calls[0] as any)[0][0]).toMatchObject({ userId: 'new-u', organizationId: 'org-1', role: 'admin' });
    expect(mockAssignBuiltinAdminRole).toHaveBeenCalledTimes(1);
    expect(user.lastActiveOrgId).toBe('org-1');
    expect(invitation.status).toBe('accepted');
    expect((invitation as { acceptedVia?: string }).acceptedVia).toBe('email');
    expect(res).toMatchObject({ organizationId: 'org-1', organizationName: 'Acme', role: 'admin', userId: 'new-u' });
  });

  it('refuses an invitation sent to a different address (no membership)', async () => {
    mockInvitationFindOne.mockReturnValue(sessionResolving(makeInvitation('member')));
    const user = { ...newUser(), email: 'someone-else@example.com' };

    await expect(invitationService.acceptForRegistration('tok', user as never, {} as never)).rejects.toThrow(errors.INV_EMAIL_MISMATCH);
    expect(mockUoCreate).not.toHaveBeenCalled();
  });

  it('refuses an OAuth-only invitation on the email/password path', async () => {
    mockInvitationFindOne.mockReturnValue(sessionResolving({ ...makeInvitation('member'), canAcceptViaEmail: () => false }));

    await expect(invitationService.acceptForRegistration('tok', newUser() as never, {} as never)).rejects.toThrow(errors.INV_EMAIL_NOT_ALLOWED);
    expect(mockUoCreate).not.toHaveBeenCalled();
  });

  it('refuses an invitation into a soft-deleted org', async () => {
    mockInvitationFindOne.mockReturnValue(sessionResolving(makeInvitation('member')));
    mockOrgFindById.mockReturnValue(sessionResolving({ _id: 'org-1', name: 'Acme', deletedAt: new Date() }));

    await expect(invitationService.acceptForRegistration('tok', newUser() as never, {} as never)).rejects.toThrow(errors.INV_ORG_NOT_FOUND);
    expect(mockUoCreate).not.toHaveBeenCalled();
  });

  it('refuses an invitation that is no longer pending', async () => {
    mockInvitationFindOne.mockReturnValue(sessionResolving({ ...makeInvitation('member'), status: 'revoked' }));

    await expect(invitationService.acceptForRegistration('tok', newUser() as never, {} as never)).rejects.toThrow();
    expect(mockUoCreate).not.toHaveBeenCalled();
  });
});

describe('InvitationService.accept — the inviter notification is post-commit', () => {
  /**
   * The acceptance mail must be sent once per COMMIT, not once per attempt.
   *
   * It used to be sent from inside `processAcceptance`, which runs inside the
   * caller's transaction — so a WriteConflict re-running the body mailed the
   * inviter again, and a terminal failure at commit announced an acceptance
   * that rolled back. Mail is not transactional; neither is recoverable.
   */
  it('mails the inviter ONCE even when the transaction body is retried', async () => {
    txAttempts = 2;
    // Four lookups now happen (accepting user + inviter, per attempt). Without
    // all four the second pass would find no inviter and the assertion would
    // pass for the wrong reason.
    mockUserFindById.mockReset();
    for (let i = 0; i < 2; i += 1) {
      mockUserFindById
        .mockReturnValueOnce(sessionResolving({ _id: 'u1', email: INVITEE_EMAIL, lastActiveOrgId: 'existing-org', save: jest.fn() }))
        .mockReturnValueOnce(sessionResolving({ _id: 'inviter-1', email: 'boss@example.com', username: 'boss' }));
    }
    // A FRESH doc per read, because an aborted transaction's writes are rolled
    // back: the retry re-reads a still-`pending` invitation. Handing back the
    // same object would let the first pass's `status = 'accepted'` leak into
    // the second and fail as INV_ACCEPTED, which is not what a retry is.
    mockInvitationFindOne.mockImplementation(() => sessionResolving(makeInvitation('member')));

    await invitationService.accept('tok', 'u1');

    // The body really did run twice — otherwise this test proves nothing.
    expect(mockUoCreate).toHaveBeenCalledTimes(2);
    expect(mockSendInvitationAccepted).toHaveBeenCalledTimes(1);
    expect(mockSendInvitationAccepted).toHaveBeenCalledWith('boss@example.com', 'boss', undefined, 'Acme');
  });

  it('mails the inviter once on the ordinary single-attempt path', async () => {
    mockInvitationFindOne.mockReturnValue(sessionResolving(makeInvitation('member')));
    await invitationService.accept('tok', 'u1');
    expect(mockSendInvitationAccepted).toHaveBeenCalledTimes(1);
  });

  it('does not mail anyone when the invitee is already a member', async () => {
    // The tombstone path returns before processAcceptance, so there is no notice.
    mockInvitationFindOne.mockReturnValue(sessionResolving(makeInvitation('member')));
    mockUoFindOne.mockReturnValue(sessionResolving({ _id: 'existing' }));
    await expect(invitationService.accept('tok', 'u1')).rejects.toThrow();
    expect(mockSendInvitationAccepted).not.toHaveBeenCalled();
  });
});
