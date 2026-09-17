// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `deleteUser` (DELETE /user/account) — how the controller surfaces
 * the shared delete cascade's guards (see user-cascade.test.ts for the guards
 * themselves): an org owner gets 400 (transfer first), the last member of a
 * privileged Role gets 409, a vanished user 404.
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
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

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAuthUserId: (req: any) => req.user?.sub,
  // Wrap as Express handler so callers can pass `next`. Optional error map
  // applies the same status/message mapping the real `withController` does
  // — without it, a thrown service error like 'PROFILE_OWNER_HAS_ORGS' would
  // bubble up uncaught and the test couldn't assert on the response.
  withController: (_label: string, fn: Function, errorMap?: Record<string, { status: number; message: string }>) =>
    async (req: any, res: any, _next: any) => {
      try {
        await fn(req, res);
      } catch (err) {
        const code = err instanceof Error ? err.message : String(err);
        const mapped = errorMap?.[code];
        if (mapped) {
          res.status(mapped.status).json({ success: false, message: mapped.message });
          return;
        }
        throw err;
      }
    },
}));

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
}));

jest.unstable_mockModule('../src/utils/token.js', () => ({ signPersonalAccessToken: jest.fn(), issueTokens: jest.fn(), renewSessionTokens: jest.fn() }));
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
  return { res: { status, json }, status, json };
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
