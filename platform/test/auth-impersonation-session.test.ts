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
  recordAuthzDenial: jest.fn(),
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
  operator = { _id: 'sysadmin-1', tokenVersion: 5, isSuperAdmin: true };
  mockUserFindById.mockImplementation((id: unknown) => (id === 'sysadmin-1'
    ? selectLean(operator)
    : selectLean({ _id: 'target-user', tokenVersion: 1 })));
});

/** The operator's live row, as requireAuth re-reads it. */
let operator: Record<string, unknown> | null = null;
/** A live session record redeemed by `sysadmin-1` at tokenVersion 5, as a superadmin. */
const live = (over: Record<string, unknown> = {}) => ({
  status: 'consumed',
  targetUserId: 'target-user',
  expiresAt: future(),
  requesterId: 'sysadmin-1',
  requesterTokenVersion: 5,
  requesterSuperAdmin: true,
  ...over,
});

/** A record window that is still open. */
const future = (): Date => new Date(Date.now() + 10 * 60 * 1000);

describe('requireAuth — impersonation session', () => {
  it('authenticates a live (consumed) session', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live()));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('resolves an impersonation token through the impersonation record', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live()));
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

  it('rejects a consumed session whose window has passed (expiresAt <= now)', async () => {
    mockImpFindOne.mockReturnValue(selectLean({ status: 'consumed', targetUserId: 'target-user', expiresAt: new Date(Date.now() - 1000) }));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    // `expiresAt` used to be selected and never read: a consumed record whose
    // window had closed kept authenticating for as long as the JWT lived.
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed on a consumed record with no expiresAt', async () => {
    mockImpFindOne.mockReturnValue(selectLean({ status: 'consumed', targetUserId: 'target-user' }));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

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

  it('ends the session once the OPERATOR\'s tokenVersion moves (signed out everywhere / password reset)', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live()));
    operator = { _id: 'sysadmin-1', tokenVersion: 6, isSuperAdmin: true };
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Impersonation session ended', code: 'TOKEN_REVOKED' }));
    expect(next).not.toHaveBeenCalled();
    // The operator is read by the id the RECORD names.
    expect(mockUserFindById).toHaveBeenCalledWith('sysadmin-1');
  });

  it('ends the session once the operator is deleted', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live()));
    operator = null;
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('ends a superadmin-opened session once the operator loses the flag', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live()));
    operator = { _id: 'sysadmin-1', tokenVersion: 5, isSuperAdmin: false };
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('admits a session opened under tenant (ancestor-admin) authority without the superadmin flag', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live({ requesterSuperAdmin: false, requesterClaimsVersion: 3 })));
    operator = { _id: 'sysadmin-1', tokenVersion: 5, claimsVersion: 3 };
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('treats a tenant-authority operator row with no claimsVersion as version 0', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live({ requesterSuperAdmin: false, requesterClaimsVersion: 0 })));
    operator = { _id: 'sysadmin-1', tokenVersion: 5 };
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('ends a tenant-authority session once the operator\'s claimsVersion moves (lost their tenant role)', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live({ requesterSuperAdmin: false, requesterClaimsVersion: 3 })));
    // Only claimsVersion moved: a role / membership change, no hard sign-out.
    operator = { _id: 'sysadmin-1', tokenVersion: 5, claimsVersion: 4 };
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Impersonation session ended', code: 'TOKEN_REVOKED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed on a tenant-authority record without the claims stamp', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live({ requesterSuperAdmin: false })));
    operator = { _id: 'sysadmin-1', tokenVersion: 5, claimsVersion: 0 };
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('a SUPERADMIN session survives a claimsVersion move (its authority is the flag)', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live({ requesterClaimsVersion: 3 })));
    operator = { _id: 'sysadmin-1', tokenVersion: 5, claimsVersion: 9, isSuperAdmin: true };
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('treats an operator row with no tokenVersion as version 0', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live({ requesterTokenVersion: 0 })));
    operator = { _id: 'sysadmin-1', isSuperAdmin: true };
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('fails closed on a malformed consumed record without the operator stamp', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live({ requesterTokenVersion: undefined })));
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockUserFindById).not.toHaveBeenCalledWith('sysadmin-1');
  });

  it('FAILS CLOSED when the operator cannot be read', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live()));
    mockUserFindById.mockImplementation((id: unknown) => (id === 'sysadmin-1'
      ? selectLeanThrows()
      : selectLean({ _id: 'target-user', tokenVersion: 1 })));
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token whose impersonatorId is not the operator who redeemed the record', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live({ requesterId: 'someone-else' })));
    const res = makeRes(); const next = jest.fn();
    await (requireAuth as any)(req(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a jti/sub mismatch', async () => {
    mockImpFindOne.mockReturnValue(selectLean(live({ targetUserId: 'someone-else' })));
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

describe('requireAuth — read-only impersonation backstop', () => {
  beforeEach(() => {
    mockImpFindOne.mockReturnValue(selectLean(live()));
  });

  it('refuses a WRITE on the verified claims (not only the pre-auth peek)', async () => {
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)({ method: 'POST', headers: { authorization: 'Bearer imp.jwt' } }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'IMPERSONATION_READ_ONLY' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('still admits a READ', async () => {
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)({ method: 'GET', headers: { authorization: 'Bearer imp.jwt' } }, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('verifies the WHOLE credential after the scheme — trailing segments are not dropped', async () => {
    // `Bearer <jwt> .x` defeated the pre-auth peek (4 dot-parts → `{}`) while a
    // `split(' ')[1]` read verified just `<jwt>`.
    mockVerifyAccessToken.mockImplementation(() => { throw new Error('bad'); });
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)({ method: 'POST', headers: { authorization: 'Bearer imp.jwt .x' } }, res, next);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith('imp.jwt .x');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
