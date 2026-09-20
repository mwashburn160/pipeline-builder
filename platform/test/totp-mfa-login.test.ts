// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two-leg password sign-in for an account with an authenticator app.
 *
 * The security property being pinned is that the PASSWORD ALONE PRODUCES
 * NOTHING: leg one returns a challenge handle and no token, no cookie and no
 * session slot, and leg two is what opens the session. Around that:
 *   - a wrong code does NOT burn the challenge (a mistyped digit must not cost
 *     the person their password entry), but a correct one spends it, so one
 *     handle can never yield two sessions;
 *   - every refusal is the same opaque 401, with the reason only in the audit;
 *   - the resulting session carries `amr: ['pwd', 'mfa']`;
 *   - a recovery code works here too, and leaves its own audit trail.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const mockAudit = jest.fn();
const mockIncCounter = jest.fn();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
  accessToken: 'access.jwt', refreshToken: 'refresh.jwt', expiresIn: 900,
}));
const mockVerifyCode = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockHasActiveTotp = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => false);
const mockFindByCredentials = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRejectIfSsoEnforced = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => false);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) =>
    res.status(status).json({ success: true, statusCode: status, data }),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
jest.unstable_mockModule('../src/helpers/client-info.js', () => ({ clientInfoOf: () => ({ ip: '10.0.0.1' }) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_label: string, fn: Function, map?: Record<string, { status: number; message: string }>) =>
    async (req: any, res: any) => {
      try { await fn(req, res); } catch (err) {
        const mapped = map?.[(err as Error).message];
        if (mapped) res.status(mapped.status).json({ success: false, message: mapped.message });
        else res.status(500).json({ success: false, message: 'error' });
      }
    },
}));
jest.unstable_mockModule('../src/helpers/session-cookie.js', () => ({
  deliverSessionTokens: (_req: unknown, _res: unknown, tokens: { accessToken: string; expiresIn: number }) =>
    ({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn }),
  clearRefreshCookie: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  rejectIfSsoEnforced: (...a: unknown[]) => mockRejectIfSsoEnforced(...a),
}));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: {
    findForTokenIssue: async (id: string) => ({ _id: { toString: () => id }, email: 'person@example.com', lastActiveOrgId: 'org-1' }),
    findByCredentials: (...a: unknown[]) => mockFindByCredentials(...a),
  },
  auditService: { createEvent: jest.fn(async () => undefined) },
}));
const mockVerifyRecoveryCode = jest.fn<(...a: unknown[]) => Promise<number>>();
const mockHasUnspentRecoveryCodes = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => false);
jest.unstable_mockModule('../src/services/recovery-codes-service.js', () => ({
  verifyRecoveryCode: (...a: unknown[]) => mockVerifyRecoveryCode(...a),
  hasUnspentRecoveryCodes: (...a: unknown[]) => mockHasUnspentRecoveryCodes(...a),
}));
// The org password-policy check on the login leg says "fine" here — this suite
// is about the second factor.
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  passwordShortfall: async () => null,
  assertNewPasswordAcceptable: async () => undefined,
  invitationOrgForRegistration: async () => undefined,
}));
jest.unstable_mockModule('../src/services/mfa-enrolment.js', () => ({ clearResetGraceOnEnrolment: jest.fn(async () => false) }));
jest.unstable_mockModule('../src/services/totp-service.js', () => ({
  verifyCode: (...a: unknown[]) => mockVerifyCode(...a),
  hasActiveTotp: (...a: unknown[]) => mockHasActiveTotp(...a),
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
  issueStepUpToken: jest.fn(async () => ({ token: 'stepup.jwt', expiresAt: 1 })),
  // The REAL shape — `signInAuth('pwd', { mfa: true })` is what puts `mfa` in amr.
  signInAuth: (method: string, opts: { mfa?: boolean } = {}) =>
    ({ amr: opts.mfa ? [method, 'mfa'] : [method], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  renewSessionTokens: jest.fn(async () => null),
}));

const { verifyMfaLogin } = await import('../src/controllers/totp.js');
const { createMfaChallenge, peekMfaChallenge, _resetChallengesForTests } = await import('../src/services/mfa-challenge.js');
const { TOTP_INVALID_CODE, TOTP_LOCKED_OUT } = await import('../src/services/totp-errors.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeRes() {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  return res;
}
const body = (b: Record<string, unknown>) => ({ body: b, headers: {}, ip: '10.0.0.1' }) as any;

const USER = '651111111111111111111111';

beforeEach(() => {
  _resetChallengesForTests();
  mockAudit.mockClear();
  mockIncCounter.mockClear();
  mockIssueTokens.mockClear();
  mockRejectIfSsoEnforced.mockResolvedValue(false);
});

describe('POST /auth/mfa/verify', () => {
  it('opens the session, with `mfa` in amr, and spends the challenge', async () => {
    mockVerifyCode.mockResolvedValue({ method: 'totp', recoveryCodesRemaining: 10 });
    const { challengeId } = await createMfaChallenge(USER, 'org-7');
    const res = makeRes();

    await verifyMfaLogin(body({ challengeId, code: '123456' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toMatchObject({ accessToken: 'access.jwt' });
    // The org resolved at leg one, not anything the second request supplied.
    expect(mockIssueTokens.mock.calls[0][1]).toBe('org-7');
    expect((mockIssueTokens.mock.calls[0][2] as { auth: { amr: string[] } }).auth.amr).toEqual(['pwd', 'mfa']);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.login', expect.objectContaining({
      details: { method: 'pwd+totp', via: 'totp' },
    }));
    // Single-use: the handle is gone, so it can never yield a second session.
    expect(await peekMfaChallenge(challengeId)).toBeNull();
  });

  it('names an unknown or already-spent challenge, so the UI can send them back', async () => {
    const res = makeRes();
    await verifyMfaLogin(body({ challengeId: 'nope-nope-nope', code: '123456' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    // The ONE non-opaque refusal: the handle is 256 unguessable bits, so saying
    // "that one is gone" is no oracle — and retrying a code against a dead
    // challenge can only fail forever.
    expect(res.json.mock.calls[0][0].code).toBe('TOTP_INVALID_CHALLENGE');
    // The code was never even checked — nothing to check it against.
    expect(mockVerifyCode).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('keeps the challenge alive after a WRONG code, so a typo is not a re-login', async () => {
    mockVerifyCode.mockRejectedValue(new Error(TOTP_INVALID_CODE));
    const { challengeId } = await createMfaChallenge(USER);
    const res = makeRes();

    await verifyMfaLogin(body({ challengeId, code: '000000' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].message).toBe('Invalid credentials');
    expect(await peekMfaChallenge(challengeId)).not.toBeNull();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    // The reason lives only in the audit trail.
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.login.failed', expect.objectContaining({
      details: { method: 'totp', reason: TOTP_INVALID_CODE },
    }));
  });

  it('answers a lockout with the SAME opaque 401 as a wrong code', async () => {
    mockVerifyCode.mockRejectedValue(new Error(TOTP_LOCKED_OUT));
    const { challengeId } = await createMfaChallenge(USER);
    const res = makeRes();

    await verifyMfaLogin(body({ challengeId, code: '000000' }), res);

    // Telling the caller "you are locked out" would confirm the password was right.
    expect(res.json.mock.calls[0][0].message).toBe('Invalid credentials');
    expect(mockIncCounter).toHaveBeenCalledWith('platform_totp_verifications_total', { stage: 'login', outcome: 'locked' });
  });

  it('accepts a recovery code and records that one was spent', async () => {
    mockVerifyCode.mockResolvedValue({ method: 'recovery', recoveryCodesRemaining: 4 });
    const { challengeId } = await createMfaChallenge(USER);
    const res = makeRes();

    await verifyMfaLogin(body({ challengeId, code: 'ABCDE-FGHIJ' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.recoveryCodesRemaining).toBe(4);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.mfa.recovery_used', expect.objectContaining({
      details: { context: 'login', remaining: 4 },
    }));
  });

  it('refuses to complete for an address the org has started enforcing SSO on', async () => {
    mockVerifyCode.mockResolvedValue({ method: 'totp', recoveryCodesRemaining: 10 });
    // An org can turn SSO enforcement on BETWEEN the two legs; the second one
    // re-checks rather than trusting the first.
    mockRejectIfSsoEnforced.mockResolvedValue(true);
    const { challengeId } = await createMfaChallenge(USER);
    const res = makeRes();

    await verifyMfaLogin(body({ challengeId, code: '123456' }), res);

    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(await peekMfaChallenge(challengeId)).not.toBeNull();
  });
});

describe('POST /auth/login — first leg', () => {
  it('returns a challenge and NO session for an account with an authenticator', async () => {
    mockHasActiveTotp.mockResolvedValue(true);
    mockFindByCredentials.mockResolvedValue({
      _id: { toString: () => USER }, email: 'person@example.com', lastActiveOrgId: { toString: () => 'org-1' },
    });
    const { login } = await import('../src/controllers/auth.js');
    const res = makeRes();

    await login(body({ identifier: 'person@example.com', password: 'hunter2hunter2' }), res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.mfaRequired).toBe(true);
    expect(typeof payload.challengeId).toBe('string');
    // The password alone produced nothing usable.
    expect(payload.accessToken).toBeUndefined();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
    // ...and the sign-in is not audited as having happened.
    expect(mockAudit).not.toHaveBeenCalledWith(expect.anything(), 'user.login', expect.anything());

    // The challenge names the account whose password was verified.
    expect(await peekMfaChallenge(payload.challengeId)).toMatchObject({ userId: USER, orgId: 'org-1' });
  });

  it('signs an account with no authenticator straight in, unchanged', async () => {
    mockHasActiveTotp.mockResolvedValue(false);
    mockFindByCredentials.mockResolvedValue({
      _id: { toString: () => USER }, email: 'person@example.com', lastActiveOrgId: { toString: () => 'org-1' },
    });
    const { login } = await import('../src/controllers/auth.js');
    const res = makeRes();

    await login(body({ identifier: 'person@example.com', password: 'hunter2hunter2' }), res);

    expect(mockIssueTokens).toHaveBeenCalled();
    expect((mockIssueTokens.mock.calls[0][2] as { auth: { amr: string[] } }).auth.amr).toEqual(['pwd']);
    expect(res.json.mock.calls[0][0].data).toMatchObject({ accessToken: 'access.jwt' });
  });
});

describe('recovery codes for a passkey account (no authenticator app)', () => {
  it('login offers a RECOVERY-ONLY challenge when the org policy refuses the password alone', async () => {
    mockHasActiveTotp.mockResolvedValue(false);
    mockHasUnspentRecoveryCodes.mockResolvedValue(true);
    mockIssueTokens.mockRejectedValueOnce(new Error('MFA_REQUIRED_FOR_ORG'));
    mockFindByCredentials.mockResolvedValue({
      _id: { toString: () => USER }, email: 'person@example.com', lastActiveOrgId: { toString: () => 'org-1' },
    });
    const { login } = await import('../src/controllers/auth.js');
    const res = makeRes();

    await login(body({ identifier: 'person@example.com', password: 'hunter2hunter2' }), res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload).toMatchObject({ mfaRequired: true, methods: ['recovery'] });
    expect(payload.accessToken).toBeUndefined();
    expect(await peekMfaChallenge(payload.challengeId)).toMatchObject({ userId: USER, recoveryOnly: true });
  });

  it('login still refuses (401 MFA_REQUIRED) when there are no recovery codes to offer', async () => {
    mockHasActiveTotp.mockResolvedValue(false);
    mockHasUnspentRecoveryCodes.mockResolvedValue(false);
    mockIssueTokens.mockRejectedValueOnce(new Error('MFA_REQUIRED_FOR_ORG'));
    mockFindByCredentials.mockResolvedValue({
      _id: { toString: () => USER }, email: 'person@example.com', lastActiveOrgId: { toString: () => 'org-1' },
    });
    const { login } = await import('../src/controllers/auth.js');
    const res = makeRes();

    await login(body({ identifier: 'person@example.com', password: 'hunter2hunter2' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('a recovery-only challenge is finished by a recovery code, at aal 2, and never asks the authenticator', async () => {
    mockVerifyRecoveryCode.mockResolvedValue(7);
    const { challengeId } = await createMfaChallenge(USER, 'org-1', { recoveryOnly: true });
    const res = makeRes();

    await verifyMfaLogin(body({ challengeId, code: 'ABCDE-FGHIJ' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockVerifyCode).not.toHaveBeenCalledWith(USER, 'ABCDE-FGHIJ');
    expect(mockVerifyRecoveryCode).toHaveBeenCalledWith(USER, 'ABCDE-FGHIJ');
    expect((mockIssueTokens.mock.calls[0][2] as { auth: { amr: string[] } }).auth.amr).toEqual(['pwd', 'mfa']);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.mfa.recovery_used', expect.objectContaining({
      details: { context: 'login', remaining: 7 },
    }));
    expect(await peekMfaChallenge(challengeId)).toBeNull();
  });

  it('a wrong recovery code is the same opaque 401 and does not spend the challenge', async () => {
    mockVerifyRecoveryCode.mockRejectedValue(new Error(TOTP_INVALID_CODE));
    const { challengeId } = await createMfaChallenge(USER, 'org-1', { recoveryOnly: true });
    const res = makeRes();

    await verifyMfaLogin(body({ challengeId, code: 'ZZZZZ-ZZZZZ' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(await peekMfaChallenge(challengeId)).not.toBeNull();
  });
});
