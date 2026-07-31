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
import { apiCoreMock } from './helpers/mock-api-core.js';

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

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { invitation: { expirationDays: 7, maxPendingPerOrg: 10 } },
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({ seatCapacityAvailable: jest.fn(async () => true), seatCapacityStillWithinCap: jest.fn(async () => true), userHasSeatInAccount: jest.fn(async () => false) }));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  ensureBaselineRole: (...a: unknown[]) => mockEnsureBaselineRole(...a),
  assignBuiltinAdminRole: (...a: unknown[]) => mockAssignBuiltinAdminRole(...a),
  recomputeUserOrgRole: (...a: unknown[]) => mockRecomputeUserOrgRole(...a),
}));
jest.unstable_mockModule('../src/utils/email.js', () => ({
  emailService: { sendInvitationAccepted: (...a: unknown[]) => mockSendInvitationAccepted(...a) },
}));

// Run the transaction body inline with a fake session (no live Mongo).
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Invitation: { findOne: (...a: unknown[]) => mockInvitationFindOne(...a) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUoFindOne(...a),
    create: (...a: unknown[]) => mockUoCreate(...a),
  },
}));

const { invitationService } = await import('../src/services/invitation-service.js');

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
