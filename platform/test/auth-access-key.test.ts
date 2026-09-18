// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireAuth`'s OPAQUE-KEY branch (middleware/auth.ts).
 *
 * Platform owns the key collection, so a `pb_pat_…` presented straight to it
 * (the CLI's `PLATFORM_TOKEN`) is resolved in place through the SAME service the
 * exchange endpoint uses — no HTTP round trip, no second claim shape. This pins:
 *   - a key is routed to the key branch, never to JWT verification;
 *   - `req.user` is the decoded minted token, so downstream gates see exactly
 *     what every other service sees for that key;
 *   - a refused key is a flat 401 that says nothing about WHY;
 *   - a JWT is untouched by the key branch.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Loading the auth middleware pulls in platform's config module, which refuses
// to boot without these secrets.
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);

const mockVerifyAccessToken = jest.fn<(...a: unknown[]) => unknown>();
const mockExchange = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isServiceTokenDenied: () => false,
  sendError: (res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ success: false, message: msg, code }),
}));

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/services/api-key-service.js', () => ({
  apiKeyService: { exchange: (...a: unknown[]) => mockExchange(...a) },
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  ImpersonationRequest: {},
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: {},
  UserOrganization: {},
}));

jest.unstable_mockModule('../src/utils/index.js', () => ({
  verifyAccessToken: (...a: unknown[]) => mockVerifyAccessToken(...a),
  verifyRefreshToken: jest.fn(),
}));

const { requireAuth } = await import('../src/middleware/auth.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** A syntactically valid opaque key (43 base64url chars after the prefix). */
const KEY = 'pb_pat_0123456789abcdef0123456789abcdef0123456789a';

const KEY_CLAIMS = {
  type: 'access',
  sub: 'u1',
  jti: 'key-1',
  principalType: 'user',
  token_use: 'api_key',
  amr: ['pwd'],
  aal: 1,
  auth_time: 1_700_000_000,
  organizationId: 'org-1',
  role: 'member',
  tokenVersion: 7,
};

function req(auth: string) {
  // `ip` is what the key branch forwards to the exchange — a service-account
  // key's IP allowlist is checked against it.
  return { headers: { authorization: `Bearer ${auth}` }, ip: '203.0.113.7' } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requireAuth — opaque access key', () => {
  it('resolves the key in place and attaches the minted claims', async () => {
    mockExchange.mockResolvedValue({ ok: true, accessToken: 'minted.jwt', keyId: 'key-1', userId: 'u1' });
    mockVerifyAccessToken.mockReturnValue(KEY_CLAIMS);
    const r = req(KEY); const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(r, res, next);

    expect(mockExchange).toHaveBeenCalledWith(KEY, '203.0.113.7');
    // The user lookup + tokenVersion comparison belong to the SESSION path; a
    // key's claims were just re-derived, so there is nothing stale to check.
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(r.user).toEqual(KEY_CLAIMS);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'revoked', 'expired', 'authority_revoked', 'user_gone'] as const)(
    'answers a flat 401 for a %s key, leaking no reason',
    async (reason) => {
      mockExchange.mockResolvedValue({ ok: false, reason });
      const res = makeRes(); const next = jest.fn();

      await (requireAuth as any)(req(KEY), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      // One message for every refusal — otherwise the endpoint tells an attacker
      // which of their guesses named a real key.
      expect(res.json.mock.calls[0][0].message).toBe('Invalid or revoked access key');
      expect(next).not.toHaveBeenCalled();
    },
  );

  it('leaves a JWT credential on the normal verification path', async () => {
    mockVerifyAccessToken.mockReturnValue({
      type: 'access',
      sub: 'u1',
      principalType: 'user',
      token_use: 'access',
      amr: ['pwd'],
      aal: 1,
      auth_time: 1_700_000_000,
      tokenVersion: 3,
    });
    mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ tokenVersion: 3 }) }) });
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req('header.payload.signature'), res, next);

    expect(mockExchange).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('does not route a malformed key-lookalike to the exchange', async () => {
    mockVerifyAccessToken.mockImplementation(() => { throw new Error('bad token'); });
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req('pb_pat_tooshort'), res, next);

    expect(mockExchange).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('accepts an EXCHANGED key token without re-reading the key record', async () => {
    mockVerifyAccessToken.mockReturnValue(KEY_CLAIMS);
    // tokenVersion deliberately differs from the token's: an api_key token is
    // decoupled from it (a key is killed by revoking the KEY), and it only lives
    // five minutes anyway.
    mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ tokenVersion: 99 }) }) });
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req('header.payload.signature'), res, next);

    expect(mockExchange).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('refuses an api_key token with no key id', async () => {
    mockVerifyAccessToken.mockReturnValue({ ...KEY_CLAIMS, jti: undefined });
    mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ tokenVersion: 7 }) }) });
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req('header.payload.signature'), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
