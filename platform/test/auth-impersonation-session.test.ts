// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireAuth` IMPERSONATION-SESSION branch (middleware/auth.ts).
 *
 * An impersonation token carries a `jti` — and so does the token an access key is
 * exchanged for (there it names the key). They are validated against completely
 * different records, so the impersonation branch must be tested for both halves
 * of that split:
 *
 *   1. It must be reached AT ALL, and be chosen by the `impersonatorId` claim
 *      rather than by the presence of a `jti` — a shape-based split would route
 *      one credential's traffic into the other's validation.
 *   2. It must FAIL CLOSED. Unlike the rest of auth (fail-open on a Redis blip,
 *      so an outage can't lock everyone out), an unreadable impersonation record
 *      denies: the cost is that an operator re-requests, whereas failing open
 *      would let a session someone explicitly ended keep working.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { selectLean } from './helpers/query-chain.js';

// Loading the auth middleware pulls in platform's config module, which refuses
// to boot without these secrets.
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);

const mockVerifyAccessToken = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockImpFindOne = jest.fn<(...a: unknown[]) => unknown>();

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
  ImpersonationRequest: { findOne: (...a: unknown[]) => mockImpFindOne(...a) },
  // A revoked key's exchanged token is refused (live by default here).
  PersonalAccessToken: { exists: async () => ({ _id: 'key' }) },
}));

jest.unstable_mockModule('../src/utils/token.js', () => ({
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
const req = () => ({ headers: { authorization: 'Bearer imp.jwt' } }) as any;
/** findOne(...).select(...).lean() → doc. */
const selectLeanThrows = () => ({ select: () => ({ lean: () => Promise.reject(new Error('mongo down')) }) });

beforeEach(() => {
  jest.clearAllMocks();
  // A read-only impersonation token: carries BOTH a jti and an impersonatorId.
  mockVerifyAccessToken.mockReturnValue({
    type: 'access',
    sub: 'target-user',
    principalType: 'user',
    token_use: 'access',
    amr: ['pwd'],
    aal: 1,
    auth_time: 1_700_000_000,
    jti: 'jti-1',
    impersonatorId: 'sysadmin-1',
    impersonationReadOnly: true,
    tokenVersion: 1,
    organizationId: 'org-a',
  });
  mockUserFindById.mockReturnValue(selectLean({ _id: 'target-user', tokenVersion: 1 }));
});

describe('requireAuth — impersonation session', () => {
  it('authenticates a live (consumed) session', async () => {
    mockImpFindOne.mockReturnValue(selectLean({ status: 'consumed', targetUserId: 'target-user' }));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('resolves an impersonation token through the impersonation record', async () => {
    mockImpFindOne.mockReturnValue(selectLean({ status: 'consumed', targetUserId: 'target-user' }));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    // THE regression guard: both token kinds carry a jti, so the branch must be
    // chosen by `impersonatorId` or every impersonated request 401s.
    expect(mockImpFindOne).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('rejects a REVOKED session before its token expires', async () => {
    mockImpFindOne.mockReturnValue(selectLean({ status: 'revoked', targetUserId: 'target-user' }));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    // The whole point of per-session revocation: it takes effect on the next
    // request rather than waiting out the 15-minute TTL.
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token whose session record is missing', async () => {
    mockImpFindOne.mockReturnValue(selectLean(null));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the session record cannot be read', async () => {
    mockImpFindOne.mockReturnValue(selectLeanThrows());
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    // Deliberately against the grain of the fail-open revocation store: a
    // withdrawn consent must not survive a database blip.
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a jti/sub mismatch', async () => {
    mockImpFindOne.mockReturnValue(selectLean({ status: 'consumed', targetUserId: 'someone-else' }));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not route an exchanged ACCESS-KEY token (api_key, no impersonatorId) to the impersonation branch', async () => {
    mockVerifyAccessToken.mockReturnValue({
      type: 'access',
      sub: 'u1',
      // A key token carries `jti` (the key id) just like an impersonation session
      // does — which is exactly why the branch is chosen by `impersonatorId`, not
      // by the shape of the claims.
      jti: 'key-1',
      tokenVersion: 1,
      principalType: 'user',
      token_use: 'api_key',
      amr: ['pwd'],
      aal: 1,
      auth_time: 1_700_000_000,
    });
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    expect(mockImpFindOne).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
