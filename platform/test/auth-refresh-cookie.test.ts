// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The refresh token's two transports (helpers/session-cookie.ts + the
 * `/auth/refresh` middleware chain).
 *
 * The browser gets an `HttpOnly; Secure; SameSite=Strict` cookie scoped to the
 * refresh path and NOTHING token-shaped in the body, so an XSS has nothing to
 * steal. A CLI/CI caller keeps the body flow. `requireClientType` is the CSRF
 * gate that makes the ambient cookie safe: no header, no refresh, no logout.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockVerifyRefreshToken = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isServiceTokenDenied: () => false,
  sendError: (res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) =>
    res.status(status).json({ success: true, statusCode: status, data }),
}));

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));

// `populateRequestUser` re-derives the caller's org context from these; the
// user has no membership here, which is enough for the transport assertions.
const noMembership = () => ({ lean: async () => null, sort: () => ({ lean: async () => null }) });

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: { findById: () => ({ select: () => ({ lean: async () => null }) }) },
  UserOrganization: { findOne: noMembership },
  PersonalAccessToken: { findOne: jest.fn(), updateOne: jest.fn() },
  ImpersonationRequest: { findOne: jest.fn() },
  Role: { find: jest.fn() },
  RoleAssignment: { find: jest.fn() },
}));

jest.unstable_mockModule('../src/utils/token.js', () => ({
  verifyAccessToken: jest.fn(),
  verifyRefreshToken: (...a: unknown[]) => mockVerifyRefreshToken(...a),
}));

const { deliverSessionTokens, readRefreshCookie, clearRefreshCookie, isBrowserClient } =
  await import('../src/helpers/session-cookie.js');
const { requireClientType, isValidRefreshToken } = await import('../src/middleware/auth.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeRes() {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

const TOKENS = { accessToken: 'access.jwt', refreshToken: 'refresh.jwt', expiresIn: 900 };
const browserReq = (extra: Record<string, unknown> = {}) =>
  ({ headers: { 'x-pb-client': 'web' }, body: {}, ...extra }) as any;
const cliReq = (extra: Record<string, unknown> = {}) =>
  ({ headers: { 'x-pb-client': 'cli' }, body: {}, ...extra }) as any;

describe('deliverSessionTokens — browser', () => {
  it('sets an HttpOnly, Secure, SameSite=Strict cookie on the refresh path', () => {
    const res = makeRes();
    deliverSessionTokens(browserReq(), res, TOKENS);

    expect(res.cookie).toHaveBeenCalledWith('pb_refresh', 'refresh.jwt', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth/refresh',
      maxAge: 2592000 * 1000,
    });
  });

  it('sizes Max-Age with the same strict parser as the token TTL (a malformed value is the default, not a prefix)', () => {
    const prev = process.env.REFRESH_TOKEN_EXPIRES_IN;
    try {
      // config's envInt rejects `12abc` (→ 2592000); a parseInt here would say 12.
      process.env.REFRESH_TOKEN_EXPIRES_IN = '12abc';
      const res = makeRes();
      deliverSessionTokens(browserReq(), res, TOKENS);
      expect(res.cookie.mock.calls[0][2]).toMatchObject({ maxAge: 2592000 * 1000 });

      process.env.REFRESH_TOKEN_EXPIRES_IN = '7200';
      const res2 = makeRes();
      deliverSessionTokens(browserReq(), res2, TOKENS);
      expect(res2.cookie.mock.calls[0][2]).toMatchObject({ maxAge: 7200 * 1000 });
    } finally {
      if (prev === undefined) delete process.env.REFRESH_TOKEN_EXPIRES_IN; else process.env.REFRESH_TOKEN_EXPIRES_IN = prev;
    }
  });

  it('never returns the refresh token in the body', () => {
    const body = deliverSessionTokens(browserReq(), makeRes(), TOKENS);

    expect(body).toEqual({ accessToken: 'access.jwt', expiresIn: 900 });
    expect('refreshToken' in body).toBe(false);
  });
});

describe('deliverSessionTokens — CLI/machine callers', () => {
  it('keeps the body flow and sets no cookie', () => {
    const res = makeRes();
    const body = deliverSessionTokens(cliReq(), res, TOKENS);

    expect(body).toEqual(TOKENS);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('treats a caller with no client header as non-browser', () => {
    const res = makeRes();
    const body = deliverSessionTokens({ headers: {} } as any, res, TOKENS);

    expect(body.refreshToken).toBe('refresh.jwt');
    expect(isBrowserClient({ headers: {} } as any)).toBe(false);
  });
});

describe('clearRefreshCookie', () => {
  it('clears with the attributes the cookie was set with', () => {
    const res = makeRes();
    clearRefreshCookie(res);

    expect(res.clearCookie).toHaveBeenCalledWith('pb_refresh', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth/refresh',
    });
  });
});

describe('readRefreshCookie', () => {
  it('picks the refresh cookie out of the Cookie header', () => {
    expect(readRefreshCookie({ headers: { cookie: 'theme=dark; pb_refresh=abc.def; other=1' } } as any))
      .toBe('abc.def');
  });

  it('is undefined when absent, empty or unparseable', () => {
    expect(readRefreshCookie({ headers: {} } as any)).toBeUndefined();
    expect(readRefreshCookie({ headers: { cookie: 'pb_refresh=' } } as any)).toBeUndefined();
    expect(readRefreshCookie({ headers: { cookie: 'pb_refresh=%E0%A4%A' } } as any)).toBeUndefined();
  });
});

describe('requireClientType — CSRF gate', () => {
  it('refuses a request with no client-type header', () => {
    const res = makeRes();
    const next = jest.fn();
    requireClientType({ headers: {}, path: '/refresh' } as any, res, next as any);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CLIENT_TYPE_REQUIRED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('lets any declared client through — browser or CLI', () => {
    for (const req of [browserReq({ path: '/refresh' }), cliReq({ path: '/refresh' })]) {
      const next = jest.fn();
      requireClientType(req, makeRes(), next as any);
      expect(next).toHaveBeenCalled();
    }
  });
});

describe('isValidRefreshToken — a database outage is not a bad token', () => {
  it('answers 503 (not 401) when the user lookup fails, so the client keeps its session', async () => {
    mockVerifyRefreshToken.mockReturnValue({ sub: 'u1', tokenVersion: 3, sid: 's1' });
    mockUserFindById.mockReturnValue({ select: () => Promise.reject(new Error('mongo down')) });
    const res = makeRes();
    const next = jest.fn();
    await isValidRefreshToken(cliReq({ body: { refreshToken: 'body.jwt' } }), res, next as any);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('isValidRefreshToken — which token is presented', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyRefreshToken.mockImplementation((token: unknown) => ({
      sub: 'u1', tokenVersion: 3, sid: `sid-for-${token}`,
    }));
    mockUserFindById.mockReturnValue({
      select: async () => ({
        _id: 'u1',
        tokenVersion: 3,
        username: 'u',
        email: 'u@example.com',
        isEmailVerified: true,
        refreshSessions: [
          { id: 'sid-for-cookie.jwt', kind: 'interactive', amr: ['pwd'], aal: 1, authTime: new Date(0) },
          { id: 'sid-for-body.jwt', kind: 'interactive', amr: ['pwd'], aal: 1, authTime: new Date(0) },
        ],
      }),
    });
  });

  it('accepts the CLI body token when there is no cookie', async () => {
    const res = makeRes();
    const next = jest.fn();
    await isValidRefreshToken(cliReq({ body: { refreshToken: 'body.jwt' } }), res, next as any);

    expect(next).toHaveBeenCalled();
    expect(res.locals.presentedRefreshToken).toBe('body.jwt');
    expect(res.locals.refreshSessionId).toBe('sid-for-body.jwt');
  });

  it('prefers the cookie over a body token, so injected script input cannot win', async () => {
    const res = makeRes();
    const next = jest.fn();
    await isValidRefreshToken(
      browserReq({ headers: { 'x-pb-client': 'web', 'cookie': 'pb_refresh=cookie.jwt' }, body: { refreshToken: 'body.jwt' } }),
      res,
      next as any,
    );

    expect(next).toHaveBeenCalled();
    expect(res.locals.presentedRefreshToken).toBe('cookie.jwt');
  });

  it('401s when neither transport carries a token', async () => {
    const res = makeRes();
    const next = jest.fn();
    await isValidRefreshToken(browserReq(), res, next as any);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
