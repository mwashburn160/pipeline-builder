// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireAuth` single-credential revocation (middleware/auth.ts).
 *
 * Revoking ONE credential must end the access token already minted from it —
 * on platform immediately, not at natural expiry:
 *   - a session token (`sid`) dies with its refresh-session slot (a signed-out
 *     device, a stopped machine credential, a slot killed by refresh reuse);
 *   - an exchanged access-key token (`token_use: 'api_key'`, `jti` = key id)
 *     dies with its key record — for a person's key and a service account's.
 * (Every other service gets the same effect from `revoke:sid:` / `revoke:key:`.)
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);

const mockVerifyAccessToken = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockKeyExists = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isServiceTokenDenied: () => false,
  sendError: (res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ success: false, message: msg, code }),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: { findById: jest.fn() },
  UserOrganization: { findOne: jest.fn() },
  ImpersonationRequest: { findOne: jest.fn() },
  PersonalAccessToken: { exists: (...a: unknown[]) => mockKeyExists(...a) },
}));
jest.unstable_mockModule('../src/utils/index.js', () => ({
  verifyAccessToken: (...a: unknown[]) => mockVerifyAccessToken(...a),
  verifyRefreshToken: jest.fn(),
}));

const { requireAuth } = await import('../src/middleware/auth.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const req = () => ({ headers: { authorization: 'Bearer a.jwt' } }) as any;
const selectLean = (doc: unknown) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });
const identity = { principalType: 'user', amr: ['pwd'], aal: 1, auth_time: 1_700_000_000 };

async function run(): Promise<{ res: any; next: jest.Mock }> {
  const res = makeRes(); const next = jest.fn();
  await (requireAuth as any)(req(), res, next);
  return { res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requireAuth — a session token dies with its slot', () => {
  beforeEach(() => {
    mockVerifyAccessToken.mockReturnValue({ type: 'access', sub: 'u1', token_use: 'access', tokenVersion: 1, sid: 'slot-1', ...identity });
  });

  it('admits a token whose slot is live', async () => {
    mockUserFindById.mockReturnValue(selectLean({ _id: 'u1', tokenVersion: 1, refreshSessions: [{ id: 'slot-1' }] }));
    const { res, next } = await run();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('REJECTS a token whose slot was revoked, before the token expires', async () => {
    mockUserFindById.mockReturnValue(selectLean({ _id: 'u1', tokenVersion: 1, refreshSessions: [{ id: 'other-device' }] }));
    const { res, next } = await run();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireAuth — an exchanged key token dies with its key', () => {
  it.each([
    ['a person\'s key', { sub: 'u1', token_use: 'api_key', jti: 'key-1', tokenVersion: 1, ...identity }],
    ['a service account\'s key', {
      sub: 'sa-1', token_use: 'api_key', jti: 'key-1', organizationId: 'org-1', principalType: 'service_account', amr: [], aal: 1, auth_time: 1,
    }],
  ])('admits %s while the key is live, and rejects it once revoked', async (_label, claims) => {
    mockVerifyAccessToken.mockReturnValue({ type: 'access', ...claims });
    mockUserFindById.mockReturnValue(selectLean({ _id: 'u1', tokenVersion: 1 }));

    mockKeyExists.mockResolvedValue({ _id: 'key-1' });
    expect((await run()).next).toHaveBeenCalled();
    expect(mockKeyExists).toHaveBeenCalledWith({ _id: 'key-1', revoked: false });

    mockKeyExists.mockResolvedValue(null);
    const { res, next } = await run();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('denies when the key record cannot be read', async () => {
    mockVerifyAccessToken.mockReturnValue({ type: 'access', sub: 'u1', token_use: 'api_key', jti: 'key-1', tokenVersion: 1, ...identity });
    mockUserFindById.mockReturnValue(selectLean({ _id: 'u1', tokenVersion: 1 }));
    mockKeyExists.mockRejectedValue(new Error('mongo down'));
    const { res } = await run();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireAuth — claims version vs hard revocation', () => {
  it('admits a token carrying tokenVersion + claimsVersion, and rejects one minted before a CLAIMS bump', async () => {
    // Access tokens carry the SUM; a Role/tier/feature change bumps only
    // claimsVersion — the access token goes stale here, the refresh token
    // (bare tokenVersion) stays valid and re-mints current claims.
    mockVerifyAccessToken.mockReturnValue({ type: 'access', sub: 'u1', token_use: 'access', tokenVersion: 5, ...identity });
    mockUserFindById.mockReturnValue(selectLean({ _id: 'u1', tokenVersion: 2, claimsVersion: 3 }));
    expect((await run()).next).toHaveBeenCalled();

    mockUserFindById.mockReturnValue(selectLean({ _id: 'u1', tokenVersion: 2, claimsVersion: 4 }));
    const { res, next } = await run();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
