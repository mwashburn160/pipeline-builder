// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the per-org pending-invite cap in invitationService.send.
 *
 * Invitations expire lazily, so a `status:'pending'` row can outlive its
 * `expiresAt`. The pending-cap count MUST exclude those stale rows (guard on
 * `expiresAt > now`); otherwise an org whose invites are never accepted sits at
 * its pending ceiling forever and can never invite a new email.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { seatsMock } from './helpers/seats-mock.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ invitation: { expirationDays: 7, maxPendingPerOrg: 50 } }));

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

const mockSeatCapacity = jest.fn(async (..._args: unknown[]) => true);
jest.unstable_mockModule('../src/helpers/seats.js', () => seatsMock({
  seatCapacityAvailable: (...a: unknown[]) => mockSeatCapacity(...a),
  seatCapacityStillWithinCap: jest.fn(async () => true),
  userHasSeatInAccount: jest.fn(async () => false),
}));

jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: jest.fn(async () => undefined), assignBuiltinAdminRole: jest.fn(async () => true), recomputeUserOrgRole: jest.fn(async () => undefined), assignRoles: jest.fn(async () => undefined), partitionAssignableRoles: jest.fn(async () => ({ eligible: [], rejected: [] })) }));
jest.unstable_mockModule('../src/utils/email.js', () => ({ emailService: { sendInvitation: jest.fn(async () => true) } }));

// Run the transaction body inline with a fake session (no live Mongo).
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

const sessionResolving = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

let countFilter: Record<string, unknown> | undefined;
let countReturn = 0;
const mockCountDocuments = jest.fn((filter: Record<string, unknown>) => {
  countFilter = filter;
  return sessionResolving(countReturn);
});

jest.unstable_mockModule('../src/models/index.js', () => ({
  // `invitation-service` now reaches Roles: it stores an invitation's `roleIds`
  // and re-validates them against the inviter's CURRENT authority at
  // acceptance. A bare-object namespace mock replaces the WHOLE module, so a
  // missing key makes the suite fail to LOAD rather than fail an assertion —
  // these stubs satisfy the binding for suites that assign no Roles.
  Role: { find: () => ({ session: () => ({ select: () => ({ lean: async () => [] }) }) }) },
  RoleAssignment: {
    find: () => ({ session: () => ({ select: () => ({ lean: async () => [] }) }) }),
    updateOne: async () => ({}),
    bulkWrite: async () => ({}),
  },
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: { findById: () => sessionResolving({ _id: 'org-1', name: 'Acme', owner: { toString: () => 'owner-1' } }) },
  User: { findOne: () => sessionResolving(null), findById: () => sessionResolving({ username: 'inviter' }) },
  UserOrganization: { findOne: () => sessionResolving(null) },
  Invitation: {
    findOne: () => sessionResolving(null),
    countDocuments: (...a: unknown[]) => mockCountDocuments(a[0] as Record<string, unknown>),
    create: jest.fn(async () => [{ _id: 'inv-1', token: 'tok', expiresAt: new Date(), allowedOAuthProviders: undefined }]),
  },
}));

const { invitationService } = await import('../src/services/invitation-service.js');
const { INV_MAX_REACHED, INV_UNAUTHORIZED, INV_ADMIN_REQUIRES_ADMIN } = await import('../src/services/invitation-errors.js');

const baseInput = {
  orgId: 'org-1',
  inviterId: 'owner-1',
  inviterCanManage: true,
  inviterIsAdmin: true,
  email: 'New@x.io',
  role: 'member' as const,
  invitationType: 'email' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  countFilter = undefined;
  countReturn = 0;
  mockSeatCapacity.mockResolvedValue(true);
});

describe('invitationService.send — pending-cap counts only live invites', () => {
  it('scopes the pending-count query with an expiresAt > now guard', async () => {
    await invitationService.send(baseInput);
    expect(mockCountDocuments).toHaveBeenCalledTimes(1);
    expect(countFilter?.status).toBe('pending');
    expect(countFilter?.expiresAt).toEqual({ $gt: expect.any(Date) });
  });

  it('rejects when genuinely-live pending invites are at the cap', async () => {
    countReturn = 50; // at maxPendingPerOrg
    await expect(invitationService.send(baseInput)).rejects.toThrow(INV_MAX_REACHED);
  });

  it('proceeds when live pending invites are below the cap', async () => {
    countReturn = 49;
    // `not-configured`, not "sent": this suite's config has email DISABLED, and
    // `emailService.send` returns true for that (a deliberate no-op). The old
    // boolean reported it as delivered, which is precisely the conflation
    // `InvitationDelivery` exists to end — an invitation nobody receives must
    // not come back looking like one that landed.
    await expect(invitationService.send(baseInput)).resolves.toMatchObject({ delivery: 'not-configured' });
  });
});

/**
 * WHO MAY SEND — the permission, not the coarse admin label.
 *
 * All three invitation writes used to demand owner-or-admin and nothing else,
 * which made `invitations:manage` unusable: the route admitted the permission,
 * the service then refused anyone who was not an admin. The shipped `People
 * Manager` template grants exactly that permission and is deliberately NOT an
 * admin, so every invitation it sent failed with INV_UNAUTHORIZED.
 *
 * The admin label survives as a narrower CEILING: onboarding people is not the
 * same act as minting a peer who holds every org-assignable permission.
 */
describe('invitationService.send — authority', () => {
  // The fixture org's owner is `owner-1` (see the Organization mock above).
  const asDelegate = { ...baseInput, inviterId: 'delegate-1', inviterCanManage: true, inviterIsAdmin: false };

  it('admits a non-admin holding invitations:manage', async () => {
    await expect(invitationService.send(asDelegate)).resolves.toBeDefined();
  });

  it('refuses a caller with neither the permission nor ownership', async () => {
    await expect(invitationService.send({ ...asDelegate, inviterCanManage: false }))
      .rejects.toThrow(INV_UNAUTHORIZED);
  });

  it('still admits the org OWNER, who may not carry the permission', async () => {
    await expect(invitationService.send({ ...baseInput, inviterId: 'owner-1', inviterCanManage: false, inviterIsAdmin: false }))
      .resolves.toBeDefined();
  });

  // THE CEILING, and its own sentinel: the request would have worked as a
  // member invite, so "unauthorized" sent the caller to ask for a permission
  // they already held.
  it('refuses an ADMIN invite from a non-admin delegate, with the ceiling error', async () => {
    await expect(invitationService.send({ ...asDelegate, role: 'admin' }))
      .rejects.toThrow(INV_ADMIN_REQUIRES_ADMIN);
  });

  it('allows an ADMIN invite from an admin, and from the owner', async () => {
    await expect(invitationService.send({ ...asDelegate, role: 'admin', inviterIsAdmin: true })).resolves.toBeDefined();
    await expect(invitationService.send({
      ...baseInput, inviterId: 'owner-1', role: 'admin', inviterCanManage: false, inviterIsAdmin: false,
    })).resolves.toBeDefined();
  });
});
