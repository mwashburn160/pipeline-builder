// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zero-downtime JWT secret rotation.
 *
 * During a `JWT_SECRET` rotation the deployment runs a window where both
 * old-signed and new-signed tokens are in flight. Setting `JWT_SECRET_PREVIOUS`
 * to the outgoing secret makes tokens valid under EITHER secret verify, closing
 * the auth-outage window — without weakening any existing check (expiry,
 * malformed, algorithm pinning).
 *
 * The auth module caches secrets at module scope, so each test loads a FRESH
 * copy (via jest.resetModules + dynamic import) after setting env, guaranteeing
 * the cache reads exactly this test's configuration.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ErrorCode } from '../src/types/error-codes.js';

const NEW_SECRET = 'new-rotation-secret';
const OLD_SECRET = 'old-rotation-secret';

function createMockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, user: undefined, ...overrides } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: any } {
  const res = {
    _status: 0,
    _json: null as any,
    headersSent: false,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._json = body; return res; },
  };
  return res as unknown as Response & { _status: number; _json: any };
}

/** Load a fresh auth module so its module-scoped secret cache reflects env. */
async function loadAuth() {
  jest.resetModules();
  return import('../src/middleware/auth.js');
}

function bearer(token: string): Request {
  return createMockReq({ headers: { authorization: `Bearer ${token}` } });
}

beforeEach(() => {
  process.env.JWT_SECRET = NEW_SECRET;
  delete process.env.JWT_SECRET_PREVIOUS;
});

describe('JWT rotation — verify path', () => {
  it('accepts a token signed with the PREVIOUS secret when JWT_SECRET_PREVIOUS is set', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD_SECRET;
    const { requireAuth } = await loadAuth();

    const token = jwt.sign({ type: 'access', sub: 'user1', role: 'member' }, OLD_SECRET);
    const req = bearer(token);
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user!.sub).toBe('user1');
  });

  it('still accepts a token signed with the PRIMARY secret while a previous secret is set', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD_SECRET;
    const { requireAuth } = await loadAuth();

    const token = jwt.sign({ type: 'access', sub: 'user2', role: 'member' }, NEW_SECRET);
    const req = bearer(token);
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user!.sub).toBe('user2');
  });

  it('REJECTS a previous-secret token when JWT_SECRET_PREVIOUS is NOT set', async () => {
    // No previous secret configured → old-signed token is just an invalid signature.
    const { requireAuth } = await loadAuth();

    const token = jwt.sign({ type: 'access', sub: 'user1', role: 'member' }, OLD_SECRET);
    const req = bearer(token);
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('rejects a garbage token even when a previous secret is configured', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD_SECRET;
    const { requireAuth } = await loadAuth();

    const req = bearer('not.a.jwt');
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('rejects a token signed with a secret that matches NEITHER primary nor previous', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD_SECRET;
    const { requireAuth } = await loadAuth();

    const token = jwt.sign({ type: 'access', sub: 'user1', role: 'member' }, 'some-third-secret');
    const req = bearer(token);
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('still enforces expiry — an EXPIRED primary-signed token is rejected as expired, not masked', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD_SECRET;
    const { requireAuth } = await loadAuth();

    const token = jwt.sign({ type: 'access', sub: 'user1', role: 'member' }, NEW_SECRET, { expiresIn: '-1s' });
    const req = bearer(token);
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    // The previous-secret retry must NOT swallow the expiry into a generic
    // "invalid token" — expiry stays authoritative.
    expect(res._json.code).toBe(ErrorCode.TOKEN_EXPIRED);
  });

  it('still enforces expiry for a PREVIOUS-signed token (surfaces expiry, not invalid)', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD_SECRET;
    const { requireAuth } = await loadAuth();

    const token = jwt.sign({ type: 'access', sub: 'user1', role: 'member' }, OLD_SECRET, { expiresIn: '-1s' });
    const req = bearer(token);
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json.code).toBe(ErrorCode.TOKEN_EXPIRED);
  });

  it('keeps algorithm pinning — an alg the pin excludes is rejected under both secrets', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD_SECRET;
    process.env.JWT_ALGORITHM = 'HS512'; // pin verify to HS512
    try {
      const { requireAuth } = await loadAuth();
      // Sign with HS256 (previous secret) — excluded by the HS512 pin.
      const token = jwt.sign({ type: 'access', sub: 'user1', role: 'member' }, OLD_SECRET, { algorithm: 'HS256' });
      const req = bearer(token);
      const res = createMockRes();
      const next = jest.fn();

      requireAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    } finally {
      delete process.env.JWT_ALGORITHM;
    }
  });
});

describe('JWT rotation — verifyServicePrincipal path', () => {
  it('accepts a previous-secret service token during rotation', async () => {
    process.env.JWT_SECRET_PREVIOUS = OLD_SECRET;
    const { verifyServicePrincipal } = await loadAuth();

    const token = jwt.sign({ type: 'access', sub: 'service:billing', role: 'member' }, OLD_SECRET);
    expect(verifyServicePrincipal(bearer(token))).toBe(true);
  });

  it('rejects a previous-secret service token when no previous secret is set', async () => {
    const { verifyServicePrincipal } = await loadAuth();

    const token = jwt.sign({ type: 'access', sub: 'service:billing', role: 'member' }, OLD_SECRET);
    expect(verifyServicePrincipal(bearer(token))).toBe(false);
  });
});
