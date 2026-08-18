// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireAuth` service-principal branch (middleware/auth.ts). A token minted by
 * api-core `signServiceToken` carries `sub: 'service:<name>'` and is NOT backed
 * by a User row. Regression pin: `requireAuth` must accept it WITHOUT a
 * `User.findById(sub)` — which throws a CastError on the non-ObjectId `sub` and
 * previously rejected every service→platform call with 401 "Token invalid",
 * silently breaking all inter-service hierarchy/name lookups.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockVerifyAccessToken = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ success: false, message: msg, code }),
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  toOrgId: (v: unknown) => v,
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // findById THROWS a CastError for a non-ObjectId sub — exactly what a
  // 'service:*' sub would trigger if the branch under test didn't short-circuit.
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: { findById: jest.fn() },
  UserOrganization: { findOne: jest.fn() },
  PersonalAccessToken: { findOne: jest.fn(), updateOne: jest.fn() },
}));

jest.unstable_mockModule('../src/utils/index.js', () => ({
  verifyAccessToken: (...a: unknown[]) => mockVerifyAccessToken(...a),
  verifyRefreshToken: jest.fn(),
  hashRefreshToken: jest.fn(),
}));

const { requireAuth } = await import('../src/middleware/auth.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const SERVICE_DECODED = {
  type: 'access',
  sub: 'service:message',
  username: 'message-service',
  email: 'message@internal',
  role: 'member',
  isAdmin: false,
  organizationId: '000000000000000000000001',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserFindById.mockImplementation(() => { throw new Error('CastError: not an ObjectId'); });
});

describe('requireAuth — service principal branch', () => {
  it('accepts a service token WITHOUT a User lookup', async () => {
    mockVerifyAccessToken.mockReturnValue(SERVICE_DECODED);
    const next = jest.fn();
    const req: any = { headers: { authorization: 'Bearer svc-token' } };
    const res = makeRes();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockUserFindById).not.toHaveBeenCalled(); // never look up service:* as a user
    expect(req.user).toMatchObject({ sub: 'service:message', type: 'access' });
  });

  it('still rejects a non-access service token', async () => {
    mockVerifyAccessToken.mockReturnValue({ ...SERVICE_DECODED, type: 'refresh' });
    const next = jest.fn();
    const res = makeRes();

    await requireAuth({ headers: { authorization: 'Bearer svc-token' } } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('a normal user token still goes through the User/tokenVersion path', async () => {
    mockVerifyAccessToken.mockReturnValue({ type: 'access', sub: 'user-1', role: 'admin', tokenVersion: 1 });
    mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'user-1', tokenVersion: 1 }) }) });
    const next = jest.fn();
    const res = makeRes();

    await requireAuth({ headers: { authorization: 'Bearer user-token' } } as any, res, next);

    expect(mockUserFindById).toHaveBeenCalledTimes(1); // user path exercised
    expect(next).toHaveBeenCalledTimes(1);
  });
});
