// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `deleteUser` (DELETE /user/account) — how the controller surfaces
 * the shared delete cascade's guards (see user-cascade.test.ts for the guards
 * themselves): an org owner gets 400 (transfer first), the last member of a
 * privileged Role gets 409, a vanished user 404.
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => {
    res.status(status).json({ message: msg });
  },
  sendSuccess: (res: any, status: number, data: unknown) => {
    res.status(status).json({ success: true, statusCode: status, data });
  },
  resolveUserFeatures: jest.fn(),
  resolveUserPermissions: jest.fn(() => []),
}));

jest.unstable_mockModule('mongoose', () => {
  class ObjectId { constructor(public id?: string) {} }
  // The mongoose `Schema` constructor and its `Types.Mixed` are touched at
  // module-init time by every Mongoose model loaded transitively (now via
  // the services barrel which re-exports auditService → audit-event model).
  class Schema {
    constructor(_definition?: unknown, _options?: unknown) { /* no-op */ }
    index(): void { /* no-op */ }
    method(): void { /* no-op */ }
    static Types = {
      Mixed: class Mixed {},
      ObjectId: class { constructor(public id?: string) {} },
      String: String,
      Number: Number,
      Boolean: Boolean,
      Date: Date,
    };
  }
  return {
    Types: { ObjectId },
    Schema,
    models: {} as Record<string, unknown>,
    model: jest.fn(),
  };
});

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  User: {},
  Organization: {},
  UserOrganization: {},
}));

// Mock the services barrel so the controller's `import from '../services'`
// doesn't pull in auth-service / audit-service / etc. (which would
// transitively load real config + JWT_SECRET enforcement).
const mockDeleteAccount = jest.fn<(userId: string) => Promise<void>>();
jest.unstable_mockModule('../src/services/index.js', () => ({
  userProfileService: { deleteAccount: (userId: string) => mockDeleteAccount(userId) },
  // Linking stub: the access-key handlers live in the same controller.
  apiKeyService: {},
}));

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
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: jest.fn(),
  updateProfileSchema: {},
  changePasswordSchema: {},
}));

const { deleteUser } = await import('../src/controllers/user-profile.js');


function makeReq() {
  return { user: { sub: 'user-1' } };
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  // Deleting an account drops the browser's HttpOnly refresh cookie.
  const clearCookie = jest.fn();
  return { res: { status, json, clearCookie }, status, json, clearCookie };
}

const { USER_OWNER_HAS_ORGS, PROFILE_USER_NOT_FOUND } = await import('../src/services/user-errors.js');
const { RL_LAST_PRIVILEGED_MEMBER } = await import('../src/services/roles-errors.js');

const run = async () => {
  const { res, status } = makeRes();
  await (deleteUser as unknown as (r: unknown, s: unknown, n: unknown) => Promise<void>)(makeReq(), res, jest.fn());
  return status;
};

describe('deleteUser — cascade guard mapping', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    [USER_OWNER_HAS_ORGS, 400],
    [RL_LAST_PRIVILEGED_MEMBER, 409],
    [PROFILE_USER_NOT_FOUND, 404],
  ])('maps %s to %i', async (code, httpStatus) => {
    mockDeleteAccount.mockRejectedValue(new Error(code));
    expect(await run()).toHaveBeenCalledWith(httpStatus);
  });

  it('deletes the caller\'s own account', async () => {
    mockDeleteAccount.mockResolvedValue(undefined);
    expect(await run()).toHaveBeenCalledWith(200);
    expect(mockDeleteAccount).toHaveBeenCalledWith('user-1');
  });
});
