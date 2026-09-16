// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireAuth` IMPERSONATION-SESSION branch (middleware/auth.ts).
 *
 * An impersonation token carries a `jti` — and so does a Personal Access Token.
 * They are validated against completely different records, so the impersonation
 * branch must be tested for both halves of that split:
 *
 *   1. It must be reached AT ALL. Before this branch existed the PAT lookup
 *      caught every `jti`, found no PersonalAccessToken, and 401'd — which would
 *      have broken every impersonated request the moment a jti was added.
 *   2. It must FAIL CLOSED. Unlike the rest of auth (fail-open on a Redis blip,
 *      so an outage can't lock everyone out), an unreadable impersonation record
 *      denies: the cost is that an operator re-requests, whereas failing open
 *      would let a session someone explicitly ended keep working.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockVerifyAccessToken = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockPatFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockImpFindOne = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ success: false, message: msg, code }),
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  toOrgId: (v: unknown) => v,
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: { findById: jest.fn() },
  UserOrganization: { findOne: jest.fn() },
  PersonalAccessToken: { findOne: (...a: unknown[]) => mockPatFindOne(...a), updateOne: jest.fn() },
  ImpersonationRequest: { findOne: (...a: unknown[]) => mockImpFindOne(...a) },
}));

jest.unstable_mockModule('../src/utils/index.js', () => ({
  verifyAccessToken: (...a: unknown[]) => mockVerifyAccessToken(...a),
  verifyRefreshToken: jest.fn(),
  hashRefreshToken: jest.fn(),
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
const selectLean = (doc: unknown) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });
const selectLeanThrows = () => ({ select: () => ({ lean: () => Promise.reject(new Error('mongo down')) }) });

beforeEach(() => {
  jest.clearAllMocks();
  // A read-only impersonation token: carries BOTH a jti and an impersonatorId.
  mockVerifyAccessToken.mockReturnValue({
    type: 'access',
    sub: 'target-user',
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

  it('never consults the PAT table for an impersonation token', async () => {
    mockImpFindOne.mockReturnValue(selectLean({ status: 'consumed', targetUserId: 'target-user' }));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    // THE regression guard. Both token kinds carry a jti; if the PAT branch
    // catches this one it finds nothing and 401s every impersonated request.
    expect(mockPatFindOne).not.toHaveBeenCalled();
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

  it('still routes a PAT (jti, no impersonatorId) to the PAT branch', async () => {
    mockVerifyAccessToken.mockReturnValue({ type: 'access', sub: 'u1', jti: 'pat-1', tokenVersion: 1 });
    mockPatFindOne.mockReturnValue(selectLean({ revoked: false, expiresAt: null, lastUsedAt: new Date() }));
    const res = makeRes(); const next = jest.fn();

    await (requireAuth as any)(req(), res, next);

    // The split must not steal PAT traffic either.
    expect(mockPatFindOne).toHaveBeenCalled();
    expect(mockImpFindOne).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
