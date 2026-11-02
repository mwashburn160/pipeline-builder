// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireAuth` service-principal branch (middleware/auth.ts). A token minted by
 * api-core `signServiceToken` carries `principalType: 'service'` (and names the
 * service in `sub: 'service:<name>'`) and is NOT backed by a User row. Regression pin: `requireAuth` must accept it WITHOUT a
 * `User.findById(sub)` — which throws a CastError on the non-ObjectId `sub` and
 * previously rejected every service→platform call with 401 "Token invalid",
 * silently breaking all inter-service hierarchy/name lookups.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Loading the auth middleware pulls in platform's config module, which refuses
// to boot without these secrets.
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);

const mockVerifyAccessToken = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockIsServiceTokenDenied = jest.fn<(claims: { sub?: string }) => boolean>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ success: false, message: msg, code }),
  isServiceTokenDenied: (claims: { sub?: string }) => mockIsServiceTokenDenied(claims),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stub: the auth middleware resolves impersonation sessions by jti.
  ImpersonationRequest: {},
  // A revoked key's exchanged token is refused (live by default here).
  PersonalAccessToken: { exists: async () => ({ _id: 'key' }) },
  // findById THROWS a CastError for a non-ObjectId sub — exactly what a
  // 'service:*' sub would trigger if the branch under test didn't short-circuit.
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: { findById: jest.fn() },
  UserOrganization: { findOne: jest.fn() },
}));

jest.unstable_mockModule('../src/utils/token.js', () => ({
  verifyAccessToken: (...a: unknown[]) => mockVerifyAccessToken(...a),
  verifyRefreshToken: jest.fn(),
}));

const { requireAuth, requireServiceAuth } = await import('../src/middleware/auth.js');
// Deep path — not intercepted by the barrel mock. The slot is a plain
// `res.locals` key, so arming through the real module is what the mount does.
const { armDeferredQuotaCheck } = await import('@pipeline-builder/api-core/lib/middleware/deferred-quota-check.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const SERVICE_DECODED = {
  type: 'access',
  principalType: 'service',
  token_use: 'access',
  sub: 'service:message',
  username: 'message-service',
  email: 'message@internal',
  role: 'member',
  isAdmin: false,
  organizationId: '000000000000000000000001',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIsServiceTokenDenied.mockReturnValue(false);
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
    mockVerifyAccessToken.mockReturnValue({
      type: 'access',
      sub: 'user-1',
      role: 'admin',
      tokenVersion: 1,
      // A user token must carry the identity claims or requireAuth fails closed.
      principalType: 'user',
      token_use: 'access',
      amr: ['pwd'],
      aal: 1,
      auth_time: 1_700_000_000,
    });
    mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'user-1', tokenVersion: 1 }) }) });
    const next = jest.fn();
    const res = makeRes();

    await requireAuth({ headers: { authorization: 'Bearer user-token' } } as any, res, next);

    expect(mockUserFindById).toHaveBeenCalledTimes(1); // user path exercised
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireAuth — identity claims are mandatory', () => {
  it.each([
    ['no principalType/token_use at all', { type: 'access', sub: 'user-1', role: 'admin', tokenVersion: 1 }],
    ['an unknown principalType', { type: 'access', sub: 'user-1', role: 'admin', principalType: 'robot', token_use: 'access' }],
    ['a user principal missing its assurance claims', { type: 'access', sub: 'user-1', role: 'admin', principalType: 'user', token_use: 'access' }],
    ['a service principal whose subject does not name a service', { type: 'access', sub: 'user-1', role: 'admin', principalType: 'service', token_use: 'access' }],
  ])('rejects %s', async (_name, decoded) => {
    mockVerifyAccessToken.mockReturnValue(decoded);
    const next = jest.fn();
    const res = makeRes();

    await requireAuth({ headers: { authorization: 'Bearer t' } } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockUserFindById).not.toHaveBeenCalled();
  });
});

describe('service-token kill-switch (SERVICE_TOKEN_DENYLIST)', () => {
  it.each([
    ['requireAuth', requireAuth],
    ['requireServiceAuth', requireServiceAuth],
  ])('%s rejects a denylisted service principal with 401 TOKEN_REVOKED', async (_name, mw) => {
    mockVerifyAccessToken.mockReturnValue(SERVICE_DECODED);
    mockIsServiceTokenDenied.mockImplementation((claims) => claims.sub === 'service:message');
    const next = jest.fn();
    const res = makeRes();

    await mw({ headers: { authorization: 'Bearer svc-token' } } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock<AnyFn>).mock.calls[0][0]).toMatchObject({ code: 'TOKEN_REVOKED' });
  });

  it('requireServiceAuth still admits a service that is not denylisted', async () => {
    mockVerifyAccessToken.mockReturnValue(SERVICE_DECODED);
    const next = jest.fn();
    await requireServiceAuth({ headers: { authorization: 'Bearer svc-token' } } as any, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// The apiCalls check `platformApiCallsQuota` arms at mount time
// (middleware/quota.ts) is RUN by requireAuth once the caller is verified —
// platform authenticates per route, so this is the only post-verification choke
// point. Exactly once per request, and a plain next() when nothing is armed.
describe('requireAuth — deferred apiCalls quota check', () => {
  const USER_DECODED = {
    type: 'access',
    sub: 'user-1',
    role: 'admin',
    tokenVersion: 1,
    principalType: 'user',
    token_use: 'access',
    amr: ['pwd'],
    aal: 1,
    auth_time: 1_700_000_000,
  };
  const resWithLocals = () => Object.assign(makeRes(), { locals: {} as Record<string, unknown> });

  it.each([
    ['a user', USER_DECODED],
    ['a service principal', SERVICE_DECODED],
  ])('runs an armed check exactly once, after verifying %s', async (_name, decoded) => {
    mockVerifyAccessToken.mockReturnValue(decoded);
    mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'user-1', tokenVersion: 1 }) }) });
    const order: string[] = [];
    const check = jest.fn((req: any, _res: any, next: () => void) => {
      // The identity is already on the request when the check runs.
      order.push(`check:${req.user?.sub}`);
      next();
    });
    const next = jest.fn(() => { order.push('next'); });
    const req: any = { headers: { authorization: 'Bearer t' } };
    const res = resWithLocals();
    armDeferredQuotaCheck(res, check as any);

    await requireAuth(req, res, next);
    // A second requireAuth in the same chain must not run it again.
    await requireAuth(req, res, next);

    expect(check).toHaveBeenCalledTimes(1);
    expect(order).toEqual([`check:${decoded.sub}`, 'next', 'next']);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('lets an armed check that refuses (429) stop the chain', async () => {
    mockVerifyAccessToken.mockReturnValue(SERVICE_DECODED);
    const check = jest.fn((_req: any, r: any) => { r.status(429).json({ success: false }); });
    const next = jest.fn();
    const res = resWithLocals();
    armDeferredQuotaCheck(res, check as any);

    await requireAuth({ headers: { authorization: 'Bearer t' } } as any, res, next);

    expect(check).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('is a plain next() when nothing is armed', async () => {
    mockVerifyAccessToken.mockReturnValue(SERVICE_DECODED);
    const next = jest.fn();
    const res = resWithLocals();
    await requireAuth({ headers: { authorization: 'Bearer t' } } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('never runs an armed check for a caller it rejects', async () => {
    mockVerifyAccessToken.mockReturnValue({ ...SERVICE_DECODED, type: 'refresh' });
    const check = jest.fn();
    const res = resWithLocals();
    armDeferredQuotaCheck(res, check as any);
    await requireAuth({ headers: { authorization: 'Bearer t' } } as any, res, jest.fn());
    expect(check).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
