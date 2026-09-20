// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /auth/step-up/totp` — earning the standard step-up token with an
 * authenticator code.
 *
 * What matters: it issues THE SAME token every other factor issues (so nothing
 * downstream has to know which factor was used), it records `method: 'totp'` for
 * audit, a recovery code satisfies it and leaves its own trail, and a refusal
 * audits + meters without issuing anything.
 *
 * The `amr: ['stepup', 'mfa']` claim the token itself carries — the groundwork
 * #8 will read — is pinned in `totp-step-up-claims.test.ts`, which needs the
 * REAL `utils/token` this suite stubs.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const mockAudit = jest.fn();
const mockIncCounter = jest.fn();
const mockVerifyCode = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIssueStepUpToken = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => ({ token: 'stepup.jwt', expiresAt: 42 }),
);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
jest.unstable_mockModule('../src/helpers/client-info.js', () => ({ clientInfoOf: () => ({}) }));
jest.unstable_mockModule('../src/helpers/session-cookie.js', () => ({ deliverSessionTokens: () => ({}), clearRefreshCookie: jest.fn() }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ rejectIfSsoEnforced: async () => false }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { findForTokenIssue: async () => null }, auditService: { createEvent: jest.fn() },
}));
jest.unstable_mockModule('../src/services/totp-service.js', () => ({
  verifyCode: (...a: unknown[]) => mockVerifyCode(...a),
  hasActiveTotp: async () => true,
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/utils/token.js', () => ({
  issueStepUpToken: (...a: unknown[]) => mockIssueStepUpToken(...a),
  issueTokens: jest.fn(),
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  renewSessionTokens: jest.fn(async () => null),
}));

const { stepUpVerifyTotp } = await import('../src/controllers/totp.js');
const { TOTP_INVALID_CODE, TOTP_LOCKED_OUT } = await import('../src/services/totp-errors.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const USER = '651111111111111111111111';
const req = (code: string) => ({ user: { sub: USER }, body: { code }, headers: {} }) as any;

beforeEach(() => {
  mockAudit.mockClear();
  mockIncCounter.mockClear();
  mockIssueStepUpToken.mockClear();
});

describe('POST /auth/step-up/totp', () => {
  it('issues the standard step-up token, recording the method', async () => {
    mockVerifyCode.mockResolvedValue({ method: 'totp', recoveryCodesRemaining: 10 });
    const res = makeRes();

    await stepUpVerifyTotp(req('123456'), res);

    expect(mockIssueStepUpToken).toHaveBeenCalledWith(USER, 'totp');
    // Same response shape as password / passkey / re-auth — callers replay
    // `stepUpToken` as `X-Step-Up-Token` without knowing how it was earned.
    expect(res.json.mock.calls[0][0].data).toMatchObject({
      ok: true, stepUpToken: 'stepup.jwt', expiresAt: 42, method: 'totp', via: 'totp',
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.step-up', expect.objectContaining({
      details: { method: 'totp', via: 'totp' },
    }));
    expect(mockIncCounter).toHaveBeenCalledWith('platform_step_up_total', { method: 'totp', outcome: 'success' });
  });

  it('accepts a recovery code and records that one was spent', async () => {
    mockVerifyCode.mockResolvedValue({ method: 'recovery', recoveryCodesRemaining: 3 });
    const res = makeRes();

    await stepUpVerifyTotp(req('ABCDE-FGHIJ'), res);

    expect(res.json.mock.calls[0][0].data).toMatchObject({ via: 'recovery', recoveryCodesRemaining: 3 });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.mfa.recovery_used', expect.objectContaining({
      details: { context: 'step-up', remaining: 3 },
    }));
  });

  it('issues nothing on a wrong code, and leaves a failure trail', async () => {
    mockVerifyCode.mockRejectedValue(new Error(TOTP_INVALID_CODE));
    const res = makeRes();

    await stepUpVerifyTotp(req('000000'), res);

    expect(mockIssueStepUpToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.login.failed', expect.objectContaining({
      targetType: 'step-up', outcome: 'failure',
    }));
    expect(mockIncCounter).toHaveBeenCalledWith('platform_step_up_total', { method: 'totp', outcome: 'failure' });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_totp_verifications_total', { stage: 'stepup', outcome: 'failure' });
  });

  it('answers a lockout with 429, distinctly from a wrong code', async () => {
    mockVerifyCode.mockRejectedValue(new Error(TOTP_LOCKED_OUT));
    const res = makeRes();

    await stepUpVerifyTotp(req('000000'), res);

    // Unlike the SIGN-IN path, the caller here is already authenticated — there
    // is nothing to conceal, and "wait a few minutes" is actionable.
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockIncCounter).toHaveBeenCalledWith('platform_totp_verifications_total', { stage: 'stepup', outcome: 'locked' });
  });

  it('rejects a body with no code before touching the service', async () => {
    const res = makeRes();
    await stepUpVerifyTotp({ user: { sub: USER }, body: {}, headers: {} } as any, res);
    expect(mockIssueStepUpToken).not.toHaveBeenCalled();
  });
});
