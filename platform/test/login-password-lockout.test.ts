// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/auth/login` with the DURABLE per-account password lockout
 * (helpers/password-lockout.ts; the helper itself: password-lockout.integration.test.ts).
 *
 *  - a REAL account reserves an attempt BEFORE the password is compared; a
 *    refused reservation answers the lockout's 429 without comparing anything;
 *  - a wrong password turns the reservation into a failure; an unknown
 *    identifier reserves and counts nothing (there is nothing to lock);
 *  - while locked, BOTH a wrong and a right password get the same 429 the Redis
 *    bucket gives (RATE_LIMIT_EXCEEDED + retryAfterSeconds) — a correct guess
 *    during a lockout reveals nothing and opens no session;
 *  - a right password on an unlocked account clears the run.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type */
const mockAudit = jest.fn();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
  accessToken: 'access.jwt', refreshToken: 'refresh.jwt', expiresIn: 900,
}));
const mockHasActiveTotp = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => false);
const mockVerifyCode = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindByCredentials = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockResolveIdentifier = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
const mockShortfall = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
const mockAssertAcceptable = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string, details?: unknown) =>
    res.status(status).json({ success: false, message: msg, code, ...(details ? { details } : {}) }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a), recordAuditEvent: jest.fn() }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/helpers/client-info.js', () => ({ clientInfoOf: () => ({ ip: '10.0.0.1' }) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/session-cookie.js', () => ({
  deliverSessionTokens: (_q: unknown, _s: unknown, t: { accessToken: string }) => ({ accessToken: t.accessToken }),
  clearRefreshCookie: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ rejectIfSsoEnforced: async () => false }));
jest.unstable_mockModule('../src/helpers/bootstrap-admin.js', () => ({
  isBootstrapExceptionOpen: async () => false,
  isBootstrapSuperAdminEmail: () => false,
  recordBootstrapSession: jest.fn(),
  closeBootstrapExceptionOnEnrolment: jest.fn(),
}));
// The durable password lockout (helpers/password-lockout.ts) has its own suite.
class MockLockedOut extends Error {
  retryAfterSeconds = 42;
  constructor() { super('PASSWORD_LOCKED_OUT'); }
}
type Attempt = { userId: string; reservationId: string };
const mockReserve = jest.fn<(id: string) => Promise<Attempt>>(async (userId) => ({ userId, reservationId: 'r1' }));
const mockRecordFailure = jest.fn<(id: string, rid?: string) => Promise<void>>(async () => undefined);
const mockComplete = jest.fn<(a: Attempt) => Promise<void>>(async () => undefined);
const mockRelease = jest.fn<(a: Attempt) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/helpers/password-lockout.js', () => ({
  PASSWORD_LOCKOUT_MESSAGE: 'Too many failed sign-in attempts for this account.',
  PasswordLockedOutError: MockLockedOut,
  reservePasswordAttempt: (id: string) => mockReserve(id),
  recordPasswordFailure: (id: string, rid?: string) => mockRecordFailure(id, rid),
  completePasswordAttempt: (a: Attempt) => mockComplete(a),
  releasePasswordAttempt: (a: Attempt) => mockRelease(a),
}));
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  passwordShortfall: (...a: unknown[]) => mockShortfall(...a),
  assertNewPasswordAcceptable: (...a: unknown[]) => mockAssertAcceptable(...a),
  invitationOrgForRegistration: async () => undefined,
}));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: {
    findForTokenIssue: async (id: string) => ({ _id: { toString: () => id }, email: 'p@example.com', lastActiveOrgId: 'org-1', tokenVersion: 2 }),
    findByCredentials: (...a: unknown[]) => mockFindByCredentials(...a),
    resolveIdentifier: (...a: unknown[]) => mockResolveIdentifier(...a),
  },
  auditService: { createEvent: jest.fn(async () => undefined) },
}));
jest.unstable_mockModule('../src/services/recovery-codes-service.js', () => ({
  verifyRecoveryCode: jest.fn(), hasUnspentRecoveryCodes: async () => false,
}));
jest.unstable_mockModule('../src/services/mfa-enrolment.js', () => ({ clearResetGraceOnEnrolment: jest.fn(async () => false), clearMfaNudgeOnEnrolment: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/services/totp-service.js', () => ({
  verifyCode: (...a: unknown[]) => mockVerifyCode(...a),
}));
jest.unstable_mockModule('../src/helpers/auth-factors.js', () => ({
  ACTIVE_TOTP: { activatedAt: { $ne: null } },
  hasActiveTotp: (...a: unknown[]) => mockHasActiveTotp(...a),
  hasAnyMfaFactor: async () => false,
}));
jest.unstable_mockModule('../src/services/session/access-tokens.js', () => ({
  enforceOrgAssurance: async (_u: unknown, _m: unknown, a: unknown) => a,
  issueStepUpToken: jest.fn(),
  signInAuth: (method: string, opts: { mfa?: boolean } = {}) =>
    ({ amr: opts.mfa ? [method, 'mfa'] : [method], aal: opts.mfa ? 2 : 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
}));
jest.unstable_mockModule('../src/services/session/refresh-sessions.js', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
  renewSessionTokens: jest.fn(async () => null),
  switchSessionOrg: jest.fn(),
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, b: unknown) => b,
  requiredPasswordChangeSchema: {},
  loginSchema: {},
  registerSchema: {},
  completeOnboardingSchema: {},
  joinOrgSchema: {},
  mfaVerifySchema: {},
  totpCodeSchema: {},
}));

const { _resetAllPendingStoresForTests } = await import('../src/helpers/pending-state-store.js');
const { login } = await import('../src/controllers/auth.js');

function makeRes() {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}
const req = (b: Record<string, unknown>) => ({ body: b, headers: {}, ip: '10.0.0.1' }) as any;
const body = (res: any) => res.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  _resetAllPendingStoresForTests();
  mockHasActiveTotp.mockResolvedValue(false);
  mockShortfall.mockResolvedValue(null);
  mockReserve.mockImplementation(async (userId) => ({ userId, reservationId: 'r1' }));
  mockComplete.mockResolvedValue(undefined);
  mockResolveIdentifier.mockResolvedValue({ userId: 'u1', orgId: 'org-1' });
  mockFindByCredentials.mockResolvedValue({
    _id: { toString: () => 'u1' }, email: 'p@example.com', lastActiveOrgId: { toString: () => 'org-1' },
  });
});

/** Assert the response is the Redis bucket's own 429 shape. */
function expectLockedOut(res: any): void {
  expect(res.status).toHaveBeenCalledWith(429);
  expect(body(res)).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', details: { retryAfterSeconds: 42 } });
  expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '42');
}

describe('POST /auth/login — durable password lockout', () => {
  it('reserves BEFORE comparing; a wrong password turns the reservation into a failure and answers 401', async () => {
    mockFindByCredentials.mockResolvedValue(null);
    const res = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'wrong' }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockReserve).toHaveBeenCalledWith('u1');
    expect(mockReserve.mock.invocationCallOrder[0]).toBeLessThan(mockFindByCredentials.mock.invocationCallOrder[0]);
    expect(mockRecordFailure).toHaveBeenCalledWith('u1', 'r1');
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.login.failed', expect.objectContaining({
      targetId: 'u1', details: expect.objectContaining({ reason: 'bad-password' }),
    }));
  });

  it('an unknown identifier reserves and counts nothing — there is no account to lock', async () => {
    mockResolveIdentifier.mockResolvedValue(null);
    mockFindByCredentials.mockResolvedValue(null);
    const res = makeRes();
    await login(req({ identifier: 'nobody@example.com', password: 'wrong' }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockFindByCredentials).toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.login.failed', expect.objectContaining({
      details: expect.objectContaining({ reason: 'unknown-identifier' }),
    }));
  });

  it('a refused reservation gets the bucket\'s 429 WITHOUT the password ever being compared', async () => {
    mockReserve.mockRejectedValue(new MockLockedOut());
    const res = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'right' }), res);
    expectLockedOut(res);
    expect(mockFindByCredentials).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.login.failed', expect.objectContaining({
      targetId: 'u1', affectedOrgId: 'org-1', details: expect.objectContaining({ reason: 'locked-out' }),
    }));
  });

  it('the RIGHT password with a lockout that landed mid-check gets the same 429 and opens no session', async () => {
    mockComplete.mockRejectedValue(new MockLockedOut());
    const res = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'right' }), res);
    expectLockedOut(res);
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('a right password completes the reservation (ends the run) and signs in', async () => {
    const res = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'right' }), res);
    expect(mockComplete).toHaveBeenCalledWith({ userId: 'u1', reservationId: 'r1' });
    expect(mockIssueTokens).toHaveBeenCalled();
  });

  it('an account that appeared between the lookups is reserved for at completion', async () => {
    mockResolveIdentifier.mockResolvedValue(null);
    const res = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'right' }), res);
    expect(mockReserve).toHaveBeenCalledWith('u1');
    expect(mockComplete).toHaveBeenCalledWith({ userId: 'u1', reservationId: 'r1' });
    expect(mockIssueTokens).toHaveBeenCalled();
  });

  it('a compare that throws gives the reservation back', async () => {
    mockFindByCredentials.mockRejectedValue(new Error('bcrypt exploded'));
    const res = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'x' }), res);
    expect(mockRelease).toHaveBeenCalledWith({ userId: 'u1', reservationId: 'r1' });
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('an unexpected lockout-store error is not swallowed (fails the sign-in, never opens it)', async () => {
    mockReserve.mockRejectedValue(new Error('mongo down'));
    const res = makeRes();
    await expect(login(req({ identifier: 'p@example.com', password: 'right' }), res)).resolves.toBeUndefined();
    expect(mockFindByCredentials).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();

    mockReserve.mockImplementation(async (userId) => ({ userId, reservationId: 'r1' }));
    mockComplete.mockRejectedValue(new Error('mongo down'));
    const res2 = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'right' }), res2);
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });
});
