// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * InvitationService.acceptViaOAuth — identity linking.
 *
 * Accepting an invite through a provider follows the same rules as social login:
 * the provider identity is matched first, and linking by email onto an existing
 * account happens only when that account's own email is verified. Otherwise
 * someone who registered an unverified account on the invitee's address would be
 * handed the invitee's provider identity and the membership.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockInvitationFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserExists = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindByIdAndUpdate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUoFindOne = jest.fn<(...a: unknown[]) => unknown>();

let constructed: Record<string, unknown> | undefined;
class MockUser {
  [k: string]: unknown;
  _id = 'new-user';
  constructor(data: Record<string, unknown>) { Object.assign(this, data); constructed = data; }
  save = jest.fn(async () => this);
  static findOne = (...a: unknown[]) => mockUserFindOne(...a);
  static exists = (...a: unknown[]) => mockUserExists(...a);
  static findByIdAndUpdate = (...a: unknown[]) => mockUserFindByIdAndUpdate(...a);
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { invitation: { expirationDays: 7, maxPendingPerOrg: 10 } } }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({ seatCapacityAvailable: jest.fn(async () => true), seatCapacityStillWithinCap: jest.fn(async () => true), userHasSeatInAccount: jest.fn(async () => false) }));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  ensureBaselineRole: jest.fn(async () => undefined),
  assignBuiltinAdminRole: jest.fn(async () => true),
  recomputeUserOrgRole: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/utils/email.js', () => ({ emailService: { sendInvitationAccepted: jest.fn(async () => undefined) } }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  Invitation: { findOne: (...a: unknown[]) => mockInvitationFindOne(...a) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  User: MockUser,
  UserOrganization: { findOne: (...a: unknown[]) => mockUoFindOne(...a), create: jest.fn(async () => [{}]) },
}));

const { invitationService } = await import('../src/services/invitation-service.js');

const q = (doc: unknown) => ({ session: () => Promise.resolve(doc) });
const EMAIL = 'invitee@example.com';
const oauth = { id: 'google-sub-1', email: EMAIL, name: 'Invitee' };

beforeEach(() => {
  jest.clearAllMocks();
  constructed = undefined;
  mockInvitationFindOne.mockReturnValue(q({
    role: 'member',
    status: 'pending',
    email: EMAIL,
    organizationId: 'org-1',
    invitedBy: 'boss',
    isExpired: () => false,
    canAcceptViaEmail: () => true,
    canAcceptViaOAuth: () => true,
    save: jest.fn(async () => undefined),
  }));
  // Stop right after linking: an existing membership short-circuits the accept.
  mockOrgFindById.mockReturnValue(q({ _id: 'org-1', name: 'Acme' }));
  mockUoFindOne.mockReturnValue(q({ _id: 'm' }));
  mockUserFindByIdAndUpdate.mockResolvedValue(undefined);
  mockUserExists.mockReturnValue(q(null));
});

describe('acceptViaOAuth — linking', () => {
  it('REFUSES to link onto an existing account whose email is unverified', async () => {
    mockUserFindOne
      .mockReturnValueOnce(q(null)) // no provider match
      .mockReturnValueOnce(q({ _id: 'planted', email: EMAIL, isEmailVerified: false }));

    await expect(invitationService.acceptViaOAuth('tok', 'google', oauth)).rejects.toThrow('ACCOUNT_EMAIL_UNVERIFIED');
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('links onto an existing VERIFIED account', async () => {
    mockUserFindOne
      .mockReturnValueOnce(q(null))
      .mockReturnValueOnce(q({ _id: 'real', email: EMAIL, isEmailVerified: true }));

    await invitationService.acceptViaOAuth('tok', 'google', oauth).catch(() => undefined);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith('real', expect.anything(), expect.anything());
  });

  it('matches the provider identity first, without an email lookup', async () => {
    mockUserFindOne.mockReturnValueOnce(q({ _id: 'linked', email: EMAIL, oauth: { google: { id: 'google-sub-1' } } }));

    await invitationService.acceptViaOAuth('tok', 'google', oauth).catch(() => undefined);
    expect(mockUserFindOne).toHaveBeenCalledTimes(1);
    expect(mockUserFindOne.mock.calls[0][0]).toEqual({ 'oauth.google.id': 'google-sub-1' });
  });

  it('picks a free username when the email local part is taken', async () => {
    mockUserFindOne.mockReturnValue(q(null));
    mockUserExists.mockReturnValueOnce(q({ _id: 'someone' })).mockReturnValue(q(null));

    await invitationService.acceptViaOAuth('tok', 'google', oauth).catch(() => undefined);
    expect(constructed?.username).toBe('invitee1');
  });
});
