// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared api-core step-up gate (src/middleware/step-up.ts):
 * verifyStepUpToken, consumeStepUpJti (single-use), and the requireStepUp
 * middleware. Uses real `jsonwebtoken` + the in-memory jti store (no Redis env
 * is set, so createEnvRedisClient returns null and the mem fallback is used).
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { requireStepUp, verifyStepUpToken, consumeStepUpJti } from '../src/middleware/step-up.js';

const SECRET = 'test-step-up-secret';

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  // Force the in-memory jti path (no cross-instance Redis in unit tests).
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
});

let jtiSeq = 0;
/** Sign a step-up token with a unique jti (so single-use tests don't collide). */
function signStepUp(overrides: Record<string, unknown> = {}, secret = SECRET): string {
  return jwt.sign({ type: 'step-up', sub: 'user-1', jti: `jti-${jtiSeq++}`, ...overrides }, secret, { expiresIn: 60 });
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, user: undefined, ...overrides } as unknown as Request;
}
function mockRes(): Response & { _status: number; _json: { code?: string } } {
  const res = {
    _status: 0,
    _json: {} as { code?: string },
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._json = body as { code?: string }; return res; },
  };
  return res as unknown as Response & { _status: number; _json: { code?: string } };
}

describe('verifyStepUpToken', () => {
  it('accepts a well-formed step-up token', () => {
    const payload = verifyStepUpToken(signStepUp({ sub: 'abc' }));
    expect(payload.type).toBe('step-up');
    expect(payload.sub).toBe('abc');
    expect(payload.jti).toBeTruthy();
  });

  it('rejects a plain access token (wrong type) that shares the secret', () => {
    const access = jwt.sign({ type: 'access', sub: 'abc', jti: 'j' }, SECRET, { expiresIn: 60 });
    expect(() => verifyStepUpToken(access)).toThrow();
  });

  it('rejects a step-up token missing a jti', () => {
    const noJti = jwt.sign({ type: 'step-up', sub: 'abc' }, SECRET, { expiresIn: 60 });
    expect(() => verifyStepUpToken(noJti)).toThrow();
  });

  it('rejects a bad signature', () => {
    expect(() => verifyStepUpToken(signStepUp({}, 'the-wrong-secret'))).toThrow();
  });

  it('accepts a token signed with JWT_SECRET_PREVIOUS during rotation', () => {
    const previous = 'old-secret';
    const token = signStepUp({ sub: 'rot' }, previous);
    process.env.JWT_SECRET_PREVIOUS = previous;
    try {
      expect(verifyStepUpToken(token).sub).toBe('rot');
    } finally {
      delete process.env.JWT_SECRET_PREVIOUS;
    }
  });
});

describe('consumeStepUpJti', () => {
  it('claims a jti once, rejects the replay', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(await consumeStepUpJti('unique-jti-A', exp)).toBe(true);
    expect(await consumeStepUpJti('unique-jti-A', exp)).toBe(false);
  });
});

describe('requireStepUp middleware', () => {
  const okUser = { sub: 'user-1' };

  it('401 UNAUTHORIZED when there is no authenticated user', async () => {
    const res = mockRes();
    const next = jest.fn();
    await requireStepUp(mockReq({ user: undefined }), res, next);
    expect(res._status).toBe(401);
    expect(res._json.code).toBe('UNAUTHORIZED');
    expect(next).not.toHaveBeenCalled();
  });

  it('401 STEP_UP_REQUIRED when the header is absent', async () => {
    const res = mockRes();
    const next = jest.fn();
    await requireStepUp(mockReq({ user: okUser as never }), res, next);
    expect(res._status).toBe(401);
    expect(res._json.code).toBe('STEP_UP_REQUIRED');
    expect(next).not.toHaveBeenCalled();
  });

  it('401 STEP_UP_INVALID when the token is malformed', async () => {
    const res = mockRes();
    const next = jest.fn();
    await requireStepUp(mockReq({ user: okUser as never, headers: { 'x-step-up-token': 'not-a-jwt' } }), res, next);
    expect(res._status).toBe(401);
    expect(res._json.code).toBe('STEP_UP_INVALID');
    expect(next).not.toHaveBeenCalled();
  });

  it('401 STEP_UP_MISMATCH when the token subject != caller', async () => {
    const res = mockRes();
    const next = jest.fn();
    const token = signStepUp({ sub: 'someone-else' });
    await requireStepUp(mockReq({ user: okUser as never, headers: { 'x-step-up-token': token } }), res, next);
    expect(res._status).toBe(401);
    expect(res._json.code).toBe('STEP_UP_MISMATCH');
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for a valid, caller-bound, fresh token', async () => {
    const res = mockRes();
    const next = jest.fn();
    const token = signStepUp({ sub: 'user-1' });
    await requireStepUp(mockReq({ user: okUser as never, headers: { 'x-step-up-token': token } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(0);
  });

  it('401 STEP_UP_REPLAY when the same token is used twice', async () => {
    const token = signStepUp({ sub: 'user-1' });
    const first = mockRes();
    const firstNext = jest.fn();
    await requireStepUp(mockReq({ user: okUser as never, headers: { 'x-step-up-token': token } }), first, firstNext);
    expect(firstNext).toHaveBeenCalledTimes(1);

    const second = mockRes();
    const secondNext = jest.fn();
    await requireStepUp(mockReq({ user: okUser as never, headers: { 'x-step-up-token': token } }), second, secondNext);
    expect(second._status).toBe(401);
    expect(second._json.code).toBe('STEP_UP_REPLAY');
    expect(secondNext).not.toHaveBeenCalled();
  });
});
