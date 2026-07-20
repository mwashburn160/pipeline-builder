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
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { invitation: { expirationDays: 7, maxPendingPerOrg: 50 } },
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));

const mockSeatCapacity = jest.fn(async () => true);
jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  seatCapacityAvailable: (...a: unknown[]) => mockSeatCapacity(...a),
}));

jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: jest.fn(async () => undefined) }));
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
  Organization: { findById: () => sessionResolving({ _id: 'org-1', name: 'Acme', owner: { toString: () => 'owner-1' } }) },
  User: { findOne: () => sessionResolving(null), findById: () => sessionResolving({ username: 'inviter' }) },
  UserOrganization: { findOne: () => sessionResolving(null) },
  Invitation: {
    findOne: () => sessionResolving(null),
    countDocuments: (...a: unknown[]) => mockCountDocuments(a[0] as Record<string, unknown>),
    create: jest.fn(async () => [{ _id: 'inv-1', token: 'tok', expiresAt: new Date(), allowedOAuthProviders: undefined }]),
  },
}));

const { invitationService, INV_MAX_REACHED } = await import('../src/services/invitation-service.js');

const baseInput = {
  orgId: 'org-1',
  inviterId: 'owner-1',
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
    await expect(invitationService.send(baseInput)).resolves.toMatchObject({ emailSent: true });
  });
});
