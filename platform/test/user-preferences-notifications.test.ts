// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification preferences on /user/preferences.
 *
 *   - The service sets ONLY the provided preference (dotted $set), so saving the
 *     mute never touches favorites/recents, and vice versa.
 *   - Reads fill defaults, so a user who never saved anything gets `false`.
 *   - The controller accepts only known preference keys with boolean values.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockFindOneAndUpdate = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, code: number, body: unknown) => res.status(code).json({ success: true, data: body }),
  sendError: (res: any, code: number, message: string, errorCode?: string) => res.status(code).json({ success: false, message, code: errorCode }),
}));
jest.unstable_mockModule('../src/helpers/active-org-info.js', () => ({ loadActiveOrgInfo: jest.fn() }));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: jest.fn(), publishUsersRevocation: jest.fn(), publishUserDeletionRevocation: jest.fn(),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ seedDefaultRoles: jest.fn() }));
jest.unstable_mockModule('../src/services/role-crud.js', () => ({ assertNotLastPrivilegedMember: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: {} } }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({ withMongoTransaction: (fn: (s: unknown) => unknown) => fn({}) }));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  // Session-auth helpers the controllers now import (see utils/token.ts).
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  findRefreshSession: jest.fn(async () => undefined),
  signApiKeyToken: jest.fn(),
  signServiceAccountToken: jest.fn(),
  membershipForOrg: jest.fn(async () => undefined),
  issueTokens: jest.fn(),
  renewSessionTokens: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  JoinRequest: {},
  // The user-delete cascade also removes the account's passkeys.
  WebAuthnCredential: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })) },
  UserTotp: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })), exists: jest.fn(async () => null) },
  MfaRecoveryCodes: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })) },
  MfaResetRequest: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })) },
  PersonalAccessToken: {},
  UserPreferences: {
    findOne: (...a: unknown[]) => mockFindOne(...a),
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
  },
  User: {},
  Organization: {},
  UserOrganization: {},
  Role: {},
  RoleAssignment: {},
}));

// The controller reaches the service through the services barrel (which loads
// every service); stub the barrel and forward to the real service under test.
const mockUpdatePreferences = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/index.js', () => ({
  userProfileService: { updatePreferences: (...a: unknown[]) => mockUpdatePreferences(...a) },
  // Linking stub: the access-key handlers live in the same controller.
  apiKeyService: {},
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({ validateBody: jest.fn(), updateProfileSchema: {}, changePasswordSchema: {} }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

const { userProfileService } = await import('../src/services/user-profile-service.js');
const { updatePreferences } = await import('../src/controllers/user-profile.js');

const lean = (doc: unknown) => ({ lean: () => Promise.resolve(doc) });

function mockRes() {
  const r: any = { statusCode: 0, body: undefined };
  r.status = jest.fn((c: number) => { r.statusCode = c; return r; });
  r.json = jest.fn((b: unknown) => { r.body = b; return r; });
  return r;
}
const put = (body: unknown) =>
  (updatePreferences as unknown as (req: any, res: any) => Promise<void>)(
    { user: { sub: 'u1', organizationId: 'org-1' }, body }, mockRes(),
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdatePreferences.mockImplementation((...a: unknown[]) => userProfileService.updatePreferences(...(a as [string, string, never])));
  mockFindOneAndUpdate.mockReturnValue(lean({ favorites: ['p1'], recents: [], notifications: { muteQuotaWarnings: true } }));
});

describe('userProfileService preferences', () => {
  it('defaults muteQuotaWarnings to false for a user who never saved preferences', async () => {
    mockFindOne.mockReturnValue(lean(null));
    await expect(userProfileService.getPreferences('u1', 'org-1')).resolves.toEqual({
      favorites: [], recents: [], notifications: { muteQuotaWarnings: false },
    });
  });

  it('sets only the notification preference — favorites and recents are left alone', async () => {
    const view = await userProfileService.updatePreferences('u1', 'org-1', { notifications: { muteQuotaWarnings: true } });

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'u1', organizationId: 'org-1' },
      { $set: { 'notifications.muteQuotaWarnings': true } },
      expect.objectContaining({ upsert: true }),
    );
    expect(view.notifications).toEqual({ muteQuotaWarnings: true });
  });

  it('saving favorites does not touch notification preferences', async () => {
    await userProfileService.updatePreferences('u1', 'org-1', { favorites: ['p1'] });
    const [, update] = mockFindOneAndUpdate.mock.calls[0] as [unknown, { $set: Record<string, unknown> }];
    expect(Object.keys(update.$set)).toEqual(['favorites']);
  });
});

describe('PUT /user/preferences — notifications validation', () => {
  it('accepts a boolean muteQuotaWarnings', async () => {
    const res = await put({ notifications: { muteQuotaWarnings: true } });
    expect(mockFindOneAndUpdate).toHaveBeenCalled();
    void res;
  });

  it.each([
    ['a non-object', { notifications: 'yes' }],
    ['an array', { notifications: [true] }],
    ['a non-boolean value', { notifications: { muteQuotaWarnings: 'true' } }],
    ['an unknown preference', { notifications: { muteEverything: true } }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const res = mockRes();
    await (updatePreferences as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'u1', organizationId: 'org-1' }, body }, res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_NOTIFICATIONS');
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
