// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `requireStepUp` middleware + the step-up token utilities.
 *
 * These two pieces together enforce the security boundary we built for
 * destructive endpoints. The middleware must reject every variant of
 * "no token, wrong token, expired token, token for a different user"
 * with a stable error code the frontend can pattern-match on.
 *
 * Token round-trips are tested against the real `jsonwebtoken` library
 * — we want to catch signature / payload-shape regressions, not just
 * mock the verify call.
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => {
    res.status(status).json({ success: false, statusCode: status, message: msg, code });
  },
  // Consumed transitively via token.js -> org-hierarchy.js.
  resolveUserFeatures: jest.fn(() => ({})),
  resolveUserPermissions: jest.fn(() => []),
  resolveOrgLineageWith: jest.fn(),
  isAncestorOrgWith: jest.fn(),
  expandOrgScopeWith: jest.fn(),
  toOrgIdString: (id: unknown) => String(id),
}));

// Pin the JWT secret so verify works without env wiring.
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    auth: {
      jwt: { secret: 'test-step-up-secret', algorithm: 'HS256' },
      refreshToken: { secret: 'test-refresh-secret', expiresIn: '7d' },
    },
  },
}));

// Token util imports `User` model transitively via the access-token issuer
// path — stub it out so we don't need mongoose.
jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    pre() { /* no-op */ }
    post() { /* no-op */ }
    virtual() { return this; }
    set() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  const Types = { ObjectId: class {} };
  return { default: { Types, Schema, models: {}, model: jest.fn() }, Types, Schema, models: {}, model: jest.fn() };
});

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {},
  Organization: {},
  UserOrganization: {},
  Role: { find: () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) }) },
  RoleAssignment: { find: () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) }) },
}));

const { _resetConsumedJtiForTests, consumeJti } = await import('../src/middleware/consumed-jti.js');
const { requireStepUp } = await import('../src/middleware/step-up.js');
const { issueStepUpToken, verifyStepUpToken } = await import('../src/utils/token.js');

import jwt from 'jsonwebtoken';

function mockReq(opts: { userId?: string; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['x-step-up-token'] = opts.token;
  return {
    user: opts.userId ? { sub: opts.userId } : undefined,
    header: (name: string) => headers[name.toLowerCase()],
    headers,
  } as any;
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  _resetConsumedJtiForTests();
});

describe('consumeJti', () => {
  it('returns true on first use, false on replay', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(consumeJti('jti-1', exp)).toBe(true);
    expect(consumeJti('jti-1', exp)).toBe(false);
  });

  it('rejects already-expired tokens', () => {
    const expiredExp = Math.floor(Date.now() / 1000) - 1;
    expect(consumeJti('jti-stale', expiredExp)).toBe(false);
  });

  it('allows different jtis from the same user concurrently', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(consumeJti('jti-a', exp)).toBe(true);
    expect(consumeJti('jti-b', exp)).toBe(true);
  });
});

describe('issueStepUpToken / verifyStepUpToken', () => {
  it('round-trips a payload bound to the user', () => {
    const { token, expiresAt } = issueStepUpToken('user-42');
    const payload = verifyStepUpToken(token);
    expect(payload.sub).toBe('user-42');
    expect(payload.type).toBe('step-up');
    expect(typeof payload.jti).toBe('string');
    expect(payload.jti.length).toBeGreaterThan(0);
    // expiresAt is "now + ttl seconds"; allow a 5s skew window.
    const expected = Math.floor(Date.now() / 1000) + 60;
    expect(Math.abs(expiresAt - expected)).toBeLessThanOrEqual(5);
  });

  it('honors a custom TTL in seconds', () => {
    const { token } = issueStepUpToken('u1', 5);
    const decoded = jwt.decode(token) as { exp: number; iat: number };
    expect(decoded.exp - decoded.iat).toBe(5);
  });

  it('emits a new jti per call', () => {
    const a = issueStepUpToken('u1');
    const b = issueStepUpToken('u1');
    expect(verifyStepUpToken(a.token).jti).not.toBe(verifyStepUpToken(b.token).jti);
  });

  it('verify rejects a token signed with a different secret', () => {
    const bogus = jwt.sign({ type: 'step-up', sub: 'u1' }, 'wrong-secret', { algorithm: 'HS256', expiresIn: 60 });
    expect(() => verifyStepUpToken(bogus)).toThrow();
  });
});

describe('requireStepUp middleware', () => {
  it('rejects unauthenticated callers (no req.user)', () => {
    const res = mockRes();
    const next = jest.fn();
    requireStepUp(mockReq({}), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when the X-Step-Up-Token header is missing — code STEP_UP_REQUIRED', () => {
    const res = mockRes();
    const next = jest.fn();
    requireStepUp(mockReq({ userId: 'u1' }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.code).toBe('STEP_UP_REQUIRED');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an invalid/expired token — code STEP_UP_INVALID', () => {
    const res = mockRes();
    const next = jest.fn();
    requireStepUp(mockReq({ userId: 'u1', token: 'not.a.real.jwt' }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0].code).toBe('STEP_UP_INVALID');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token whose sub != req.user.sub — code STEP_UP_MISMATCH', () => {
    // Issued for u-other; replayed by u1's session.
    const { token } = issueStepUpToken('u-other');
    const res = mockRes();
    const next = jest.fn();
    requireStepUp(mockReq({ userId: 'u1', token }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0].code).toBe('STEP_UP_MISMATCH');
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when token is valid for the caller', () => {
    const { token } = issueStepUpToken('u1');
    const res = mockRes();
    const next = jest.fn();
    requireStepUp(mockReq({ userId: 'u1', token }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a second use of the same token — code STEP_UP_REPLAY', () => {
    const { token } = issueStepUpToken('u1');
    const next1 = jest.fn();
    const res1 = mockRes();
    requireStepUp(mockReq({ userId: 'u1', token }), res1, next1);
    expect(next1).toHaveBeenCalled();

    // Same token replayed → consumed-jti rejects.
    const next2 = jest.fn();
    const res2 = mockRes();
    requireStepUp(mockReq({ userId: 'u1', token }), res2, next2);
    expect(res2.status).toHaveBeenCalledWith(401);
    expect((res2.json as jest.Mock).mock.calls[0][0].code).toBe('STEP_UP_REPLAY');
    expect(next2).not.toHaveBeenCalled();
  });

  it('rejects an expired token via the standard INVALID path', () => {
    // Sign a token with exp in the past so jwt.verify throws TokenExpiredError.
    const expired = jwt.sign(
      { type: 'step-up', sub: 'u1', jti: 'xx', iat: Math.floor(Date.now() / 1000) - 120 },
      'test-step-up-secret',
      { algorithm: 'HS256', expiresIn: -60 },
    );
    const res = mockRes();
    const next = jest.fn();
    requireStepUp(mockReq({ userId: 'u1', token: expired }), res, next);
    expect((res.json as jest.Mock).mock.calls[0][0].code).toBe('STEP_UP_INVALID');
    expect(next).not.toHaveBeenCalled();
  });
});
