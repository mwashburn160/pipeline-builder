// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `deleteUser` (DELETE /user/account) — the self-delete owner
 * guard. A user cannot orphan an org by deleting their account while still
 * owning it; they must transfer ownership first. This guard was added after
 * the corresponding admin-side check existed but the self-delete didn't.
 */

const mockUserOrgCount = jest.fn();
const mockUserOrgDeleteMany = jest.fn();
const mockUserFindByIdAndDelete = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  sendError: (res: any, status: number, msg: string) => {
    res.status(status).json({ message: msg });
  },
  sendSuccess: (res: any, status: number, data: unknown) => {
    res.status(status).json({ success: true, statusCode: status, data });
  },
  resolveUserFeatures: jest.fn(),
  SYSTEM_ORG_ID: 'system',
}));

jest.mock('mongoose', () => {
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

jest.mock('../src/helpers/audit', () => ({ audit: jest.fn() }));

jest.mock('../src/helpers/controller-helper', () => ({
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

jest.mock('../src/models', () => ({
  User: { findByIdAndDelete: (...args: unknown[]) => mockUserFindByIdAndDelete(...args) },
  Organization: {},
  UserOrganization: {
    countDocuments: (...args: unknown[]) => mockUserOrgCount(...args),
    deleteMany: (...args: unknown[]) => mockUserOrgDeleteMany(...args),
  },
}));

// Mock the services barrel so the controller's `import from '../services'`
// doesn't pull in auth-service / audit-service / etc. (which would
// transitively load real config + JWT_SECRET enforcement).
jest.mock('../src/services', () => ({
  PROFILE_USER_NOT_FOUND: 'PROFILE_USER_NOT_FOUND',
  PROFILE_EMAIL_TAKEN: 'PROFILE_EMAIL_TAKEN',
  PROFILE_INVALID_CREDENTIALS: 'PROFILE_INVALID_CREDENTIALS',
  PROFILE_OWNER_HAS_ORGS: 'PROFILE_OWNER_HAS_ORGS',
  userProfileService: {
    deleteAccount: async (userId: string) => {
      const ownerCount = await mockUserOrgCount({ userId, role: 'owner' });
      if (ownerCount > 0) throw new Error('PROFILE_OWNER_HAS_ORGS');
      const result = await mockUserFindByIdAndDelete(userId);
      if (!result) throw new Error('PROFILE_USER_NOT_FOUND');
      await mockUserOrgDeleteMany({ userId });
    },
  },
}));

jest.mock('../src/utils/token', () => ({ issueTokens: jest.fn() }));
jest.mock('../src/utils/validation', () => ({
  validateBody: jest.fn(),
  updateProfileSchema: {},
  changePasswordSchema: {},
}));

import { deleteUser } from '../src/controllers/user-profile';

function makeReq() {
  return { user: { sub: 'user-1' } };
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json }, status, json };
}

describe('deleteUser — self-delete owner guard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects with 400 when caller still owns at least one org', async () => {
    mockUserOrgCount.mockResolvedValue(2);

    const req = makeReq();
    const { res, status } = makeRes();
    await (deleteUser as unknown as (r: unknown, s: unknown, n: unknown) => Promise<void>)(req, res, jest.fn());

    expect(mockUserOrgCount).toHaveBeenCalledWith({
      userId: expect.anything(),
      role: 'owner',
    });
    expect(status).toHaveBeenCalledWith(400);
    expect(mockUserFindByIdAndDelete).not.toHaveBeenCalled();
    expect(mockUserOrgDeleteMany).not.toHaveBeenCalled();
  });

  it('proceeds with delete when caller owns zero orgs', async () => {
    mockUserOrgCount.mockResolvedValue(0);
    mockUserFindByIdAndDelete.mockResolvedValue({ _id: 'user-1' });
    mockUserOrgDeleteMany.mockResolvedValue({ deletedCount: 0 });

    const req = makeReq();
    const { res } = makeRes();
    await (deleteUser as unknown as (r: unknown, s: unknown, n: unknown) => Promise<void>)(req, res, jest.fn());

    expect(mockUserFindByIdAndDelete).toHaveBeenCalled();
    expect(mockUserOrgDeleteMany).toHaveBeenCalled();
  });

  it('returns 404 when user record not found', async () => {
    mockUserOrgCount.mockResolvedValue(0);
    mockUserFindByIdAndDelete.mockResolvedValue(null);

    const req = makeReq();
    const { res, status } = makeRes();
    await (deleteUser as unknown as (r: unknown, s: unknown, n: unknown) => Promise<void>)(req, res, jest.fn());

    expect(status).toHaveBeenCalledWith(404);
    expect(mockUserOrgDeleteMany).not.toHaveBeenCalled();
  });
});
