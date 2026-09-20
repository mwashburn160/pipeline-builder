// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org password policy at SIGN-IN — the one moment the plaintext exists.
 *
 * A password below the person's org minimum opens NO session: `/auth/login`
 * (or `/auth/mfa/verify`, once the second factor verified) answers
 * `{ passwordChangeRequired, challengeId, minLength }` carrying the assurance
 * the leg(s) earned (the change leg itself: password-change-required.test.ts).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
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
const mockShortfall = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
const mockAssertAcceptable = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/helpers/client-info.js', () => ({ clientInfoOf: () => ({ ip: '10.0.0.1' }) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_label: string, fn: Function) => async (req: any, res: any) => {
    try { await fn(req, res); } catch (err) {
      const e = err as { statusCode?: number; code?: string; message: string };
      res.status(e.statusCode ?? 500).json({ success: false, message: e.message, code: e.code });
    }
  },
}));
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
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  passwordShortfall: (...a: unknown[]) => mockShortfall(...a),
  assertNewPasswordAcceptable: (...a: unknown[]) => mockAssertAcceptable(...a),
  invitationOrgForRegistration: async () => undefined,
}));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: {
    findForTokenIssue: async (id: string) => ({ _id: { toString: () => id }, email: 'p@example.com', lastActiveOrgId: 'org-1' }),
    findByCredentials: (...a: unknown[]) => mockFindByCredentials(...a),
  },
  auditService: { createEvent: jest.fn(async () => undefined) },
}));
jest.unstable_mockModule('../src/services/recovery-codes-service.js', () => ({
  verifyRecoveryCode: jest.fn(), hasUnspentRecoveryCodes: async () => false,
}));
jest.unstable_mockModule('../src/services/mfa-enrolment.js', () => ({ clearResetGraceOnEnrolment: jest.fn(async () => false) }));
jest.unstable_mockModule('../src/services/totp-service.js', () => ({
  verifyCode: (...a: unknown[]) => mockVerifyCode(...a),
  hasActiveTotp: (...a: unknown[]) => mockHasActiveTotp(...a),
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
  issueStepUpToken: jest.fn(),
  signInAuth: (method: string, opts: { mfa?: boolean } = {}) =>
    ({ amr: opts.mfa ? [method, 'mfa'] : [method], aal: opts.mfa ? 2 : 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  renewSessionTokens: jest.fn(async () => null),
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, b: unknown) => b,
  requiredPasswordChangeSchema: {},
  loginSchema: {},
  registerSchema: {},
  completeOnboardingSchema: {},
  joinOrgSchema: {},
}));

const { login } = await import('../src/controllers/auth.js');
const { verifyMfaLogin } = await import('../src/controllers/totp.js');
const { createMfaChallenge, peekMfaChallenge } = await import('../src/services/mfa-challenge.js');
const { peekPasswordChangeChallenge, _resetPasswordChangeChallengesForTests } = await import('../src/services/password-change-challenge.js');

function makeRes() {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  return res;
}
const req = (b: Record<string, unknown>) => ({ body: b, headers: {}, ip: '10.0.0.1' }) as any;
const data = (res: any) => res.json.mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  _resetPasswordChangeChallengesForTests();
  mockHasActiveTotp.mockResolvedValue(false);
  mockShortfall.mockResolvedValue(null);
  mockFindByCredentials.mockResolvedValue({
    _id: { toString: () => 'u1' }, email: 'p@example.com', lastActiveOrgId: { toString: () => 'org-1' },
  });
});

describe('POST /auth/login with a password below the org policy', () => {
  it('opens NO session and returns a forced-change challenge', async () => {
    mockShortfall.mockResolvedValue({ minLength: 14, orgId: 'org-1' });
    const res = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'OldPassw0rd' }), res);

    const payload = data(res);
    expect(payload).toMatchObject({ passwordChangeRequired: true, minLength: 14 });
    expect(payload.accessToken).toBeUndefined();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(await peekPasswordChangeChallenge(payload.challengeId)).toMatchObject({ userId: 'u1', amr: ['pwd'], aal: 1, minLength: 14 });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.password.change_required', expect.objectContaining({
      affectedOrgId: 'org-1', details: { minLength: 14 },
    }));
  });

  it('an account with an authenticator app is asked for the code FIRST, carrying the requirement', async () => {
    mockShortfall.mockResolvedValue({ minLength: 14 });
    mockHasActiveTotp.mockResolvedValue(true);
    const res = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'OldPassw0rd' }), res);
    expect(data(res)).toMatchObject({ mfaRequired: true });
    expect(data(res).passwordChangeRequired).toBeUndefined();
    // The requirement rides on the MFA challenge, so the code can't skip it.
    expect(await peekMfaChallenge(data(res).challengeId)).toMatchObject({ passwordChangeMinLength: 14 });
  });

  it('a compliant password signs in exactly as before', async () => {
    const res = makeRes();
    await login(req({ identifier: 'p@example.com', password: 'LongEnoughPassw0rd' }), res);
    expect(mockIssueTokens).toHaveBeenCalled();
    expect(data(res)).toMatchObject({ accessToken: 'access.jwt' });
  });
});

describe('POST /auth/mfa/verify when the password owes a change', () => {
  it('verifies the code, then returns a change challenge at aal 2 instead of a session', async () => {
    mockVerifyCode.mockResolvedValue({ method: 'totp', recoveryCodesRemaining: 10 });
    const { challengeId } = await createMfaChallenge('u1', 'org-1', { passwordChangeMinLength: 16 });
    const res = makeRes();
    await verifyMfaLogin(req({ challengeId, code: '123456' }), res);

    const payload = data(res);
    expect(payload).toMatchObject({ passwordChangeRequired: true, minLength: 16 });
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(await peekPasswordChangeChallenge(payload.challengeId)).toMatchObject({ amr: ['pwd', 'mfa'], aal: 2, orgId: 'org-1' });
  });
});
