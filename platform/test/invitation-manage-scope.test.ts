// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the reach of InvitationService.revoke / resend: an invitation
 * in the caller's org OR one of its teams (the reach `POST /invitation/send`
 * grants with `targetOrgId`), and nothing else. Scoped to the actor's own org
 * alone, an invitation sent into a team could never be revoked or re-sent.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { seatsMock } from './helpers/seats-mock.js';

const mockInvFindOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserFindById = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIsAncestorOrg = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockSendInvitation = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ invitation: { expirationDays: 7, maxPendingPerOrg: 50 } }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ isAncestorOrg: (...a: unknown[]) => mockIsAncestorOrg(...a) }));
jest.unstable_mockModule('../src/helpers/org-authority.js', () => ({ resolveOrgAuthority: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/helpers/seats.js', () => seatsMock({
  seatCapacityAvailable: jest.fn(async () => true),
  seatCapacityStillWithinCap: jest.fn(async () => true),
  userHasSeatInAccount: jest.fn(async () => false),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: jest.fn(), assignBuiltinAdminRole: jest.fn(), recomputeUserOrgRole: jest.fn(), assignRoles: jest.fn(), partitionAssignableRoles: jest.fn() }));
jest.unstable_mockModule('../src/utils/email.js', () => ({ emailService: { sendInvitation: (...a: unknown[]) => mockSendInvitation(...a) } }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({ withMongoTransaction: (cb: (s: unknown) => unknown) => cb({}) }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: {},
  RoleAssignment: {},
  PersonalAccessToken: {},
  UserPreferences: {},
  Invitation: { findOne: (...a: unknown[]) => mockInvFindOne(...a) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  UserOrganization: {},
}));

const { invitationService } = await import('../src/services/invitation-service.js');
const { INV_NOT_FOUND } = await import('../src/services/invitation-errors.js');

const INV_ID = '64b000000000000000000001';

function pendingInvitation(organizationId: string) {
  return {
    _id: INV_ID,
    organizationId,
    status: 'pending',
    email: 'new@x.io',
    role: 'member',
    invitedBy: 'u1',
    token: 'tok',
    expiresAt: new Date(Date.now() + 86_400_000),
    invitationType: 'email',
    save: jest.fn(async () => undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgFindById.mockResolvedValue({ _id: 'team-1', name: 'Team', owner: { toString: () => 'someone-else' } });
  mockUserFindById.mockResolvedValue({ _id: 'u1', username: 'boss' });
});

describe('invitation revoke / resend reach', () => {
  it('revokes an invitation in one of the caller org\'s TEAMS', async () => {
    const inv = pendingInvitation('team-1');
    mockInvFindOne.mockResolvedValue(inv);
    mockIsAncestorOrg.mockResolvedValue(true);

    const out = await invitationService.revoke(INV_ID, 'parent-1', 'u1', true);

    expect(mockIsAncestorOrg).toHaveBeenCalledWith('parent-1', 'team-1');
    expect(inv.status).toBe('revoked');
    expect(out.organizationId).toBe('team-1');
  });

  it('refuses an invitation in an org the caller does not reach, as not found', async () => {
    mockInvFindOne.mockResolvedValue(pendingInvitation('stranger-org'));
    mockIsAncestorOrg.mockResolvedValue(false);

    await expect(invitationService.revoke(INV_ID, 'parent-1', 'u1', true)).rejects.toThrow(INV_NOT_FOUND);
    await expect(invitationService.resend(INV_ID, 'parent-1', 'u1', true)).rejects.toThrow(INV_NOT_FOUND);
    expect(mockSendInvitation).not.toHaveBeenCalled();
  });

  it('re-sends a team invitation and names the team as its org', async () => {
    mockInvFindOne.mockResolvedValue(pendingInvitation('team-1'));
    mockIsAncestorOrg.mockResolvedValue(true);

    const out = await invitationService.resend(INV_ID, 'parent-1', 'u1', true);

    expect(out.organizationId).toBe('team-1');
    expect(mockSendInvitation).toHaveBeenCalledTimes(1);
  });

  it('does not walk the hierarchy for the caller\'s own org', async () => {
    mockInvFindOne.mockResolvedValue(pendingInvitation('parent-1'));

    await invitationService.revoke(INV_ID, 'parent-1', 'u1', true);

    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('answers not found for a malformed id without querying', async () => {
    await expect(invitationService.revoke('not-an-id', 'parent-1', 'u1', true)).rejects.toThrow(INV_NOT_FOUND);
    expect(mockInvFindOne).not.toHaveBeenCalled();
  });
});
