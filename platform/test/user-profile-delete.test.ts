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
  return {
    Types: { ObjectId },
    Schema: class { index(): void { /* no-op */ } },
    models: {} as Record<string, unknown>,
    model: jest.fn(),
  };
});

jest.mock('../src/helpers/audit', () => ({ audit: jest.fn() }));

jest.mock('../src/helpers/controller-helper', () => ({
  requireAuthUserId: (req: any) => req.user?.sub,
  // Wrap as Express handler so callers can pass `next`.
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any, _next: any) => { await fn(req, res); },
}));

jest.mock('../src/models', () => ({
  User: { findByIdAndDelete: (...args: unknown[]) => mockUserFindByIdAndDelete(...args) },
  Organization: {},
  UserOrganization: {
    countDocuments: (...args: unknown[]) => mockUserOrgCount(...args),
    deleteMany: (...args: unknown[]) => mockUserOrgDeleteMany(...args),
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
