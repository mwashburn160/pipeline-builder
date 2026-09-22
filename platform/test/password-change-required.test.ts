// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /auth/password/change-required` — the last leg of a password sign-in
 * whose password no longer meets the org policy: challenge handle + a
 * compliant NEW password → the session the sign-in earned.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type */
const mockAudit = jest.fn<AnyFn>();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ accessToken: 'access.jwt', refreshToken: 'r', expiresIn: 900 }));
const mockAssertAcceptable = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockPublishRevocation = jest.fn(async (..._args: unknown[]) => undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/helpers/client-info.js', () => ({ clientInfoOf: () => ({ ip: '10.0.0.1' }) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/session-cookie.js', () => ({
  deliverSessionTokens: (_q: unknown, _s: unknown, t: { accessToken: string }) => ({ accessToken: t.accessToken }),
}));
jest.unstable_mockModule('../src/helpers/bootstrap-admin.js', () => ({
  isBootstrapExceptionOpen: async () => false,
  recordBootstrapSession: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({ publishSessionSlotRevocation: async () => true, publishAccessKeyRevocation: async () => true, publishUserRevocation: mockPublishRevocation }));
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  assertNewPasswordAcceptable: (...a: unknown[]) => mockAssertAcceptable(...a),
}));
const account = {
  _id: { toString: () => 'u1' },
  email: 'p@example.com',
  password: 'hash',
  tokenVersion: 4,
  lastActiveOrgId: 'org-1',
  comparePassword: jest.fn(async (candidate: string) => candidate === 'OldPassw0rd'),
  save: jest.fn(async () => undefined),
};
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: () => ({ select: async () => account }) },
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  enforceOrgAssurance: async (_u: unknown, _m: unknown, a: unknown) => a,
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, b: unknown) => b,
  requiredPasswordChangeSchema: {},
}));

const { completeRequiredPasswordChange } = await import('../src/controllers/password-change-required.js');
const {
  createPasswordChangeChallenge, claimPasswordChangeChallenge, restorePasswordChangeChallenge, _resetPasswordChangeChallengesForTests,
} = await import('../src/services/password-change-challenge.js');

/** Inspect a challenge without spending it (claim, then hand straight back). */
async function peekPasswordChangeChallenge(id: string) {
  const pending = await claimPasswordChangeChallenge(id);
  if (pending) await restorePasswordChangeChallenge(id, pending);
  return pending;
}

function makeRes() {
  const res: any = { locals: {} };
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}
/**
 * A faithful stand-in for production's `PasswordPolicyServiceError`
 * (src/helpers/password-policy.ts), which is what the real
 * `assertNewPasswordAcceptable` throws. The `name` is load-bearing: with the
 * real `withController` restored, the throw is answered by
 * `handleControllerError`, and its ServiceError branch honours `statusCode` +
 * `code` ONLY when `name` contains `ServiceError`. A plain `Error` carrying the
 * same two fields falls through to the 500 fallback instead.
 */
const policyRefusal = (code: string, message: string) =>
  Object.assign(new Error(message), { name: 'PasswordPolicyServiceError', statusCode: 400, code });

const req = (b: Record<string, unknown>) => ({ body: b, headers: {}, ip: '10.0.0.1' }) as any;
const open = (aal: 1 | 2 = 1) => createPasswordChangeChallenge({
  userId: 'u1', orgId: 'org-1', amr: aal === 2 ? ['pwd', 'mfa'] : ['pwd'], aal, minLength: 14,
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetPasswordChangeChallengesForTests();
  account.tokenVersion = 4;
});

describe('POST /auth/password/change-required', () => {
  it('saves a compliant password, ends other sessions, and opens the session the sign-in earned', async () => {
    const { challengeId } = await open(2);
    const res = makeRes();
    await completeRequiredPasswordChange(req({ challengeId, newPassword: 'BrandNewPassw0rd!' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockAssertAcceptable).toHaveBeenCalledWith('BrandNewPassw0rd!', { userId: 'u1' });
    expect(account.save).toHaveBeenCalled();
    expect(account.tokenVersion).toBe(5);
    expect(mockPublishRevocation).toHaveBeenCalledWith('u1');
    expect(mockIssueTokens.mock.calls[0][1]).toBe('org-1');
    // The assurance is the one the earlier leg(s) EARNED — never raised here.
    expect(mockIssueTokens.mock.calls[0][2]).toMatchObject({ kind: 'interactive', auth: { amr: ['pwd', 'mfa'], aal: 2 } });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.password.change', expect.objectContaining({
      details: { reason: 'org_password_policy', minLength: 14 },
    }));
    expect(res.json.mock.calls[0][0].data).toMatchObject({ accessToken: 'access.jwt' });
    expect(await peekPasswordChangeChallenge(challengeId)).toBeNull();
  });

  it('refuses a new password the policy rejects — and keeps the handle for another try', async () => {
    mockAssertAcceptable.mockRejectedValueOnce(policyRefusal('PASSWORD_TOO_SHORT_FOR_ORG', 'too short'));
    const { challengeId } = await open();
    const res = makeRes();
    await completeRequiredPasswordChange(req({ challengeId, newPassword: 'Short1abc' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('PASSWORD_TOO_SHORT_FOR_ORG');
    expect(account.save).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(await peekPasswordChangeChallenge(challengeId)).not.toBeNull();
  });

  it('refuses re-using the current password', async () => {
    const { challengeId } = await open();
    const res = makeRes();
    await completeRequiredPasswordChange(req({ challengeId, newPassword: 'OldPassw0rd' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('PASSWORD_UNCHANGED');
    expect(account.save).not.toHaveBeenCalled();
  });

  it('names an unknown or spent handle so the UI can send the person back to sign in', async () => {
    const res = makeRes();
    await completeRequiredPasswordChange(req({ challengeId: 'nope', newPassword: 'BrandNewPassw0rd!' }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe('PASSWORD_CHANGE_CHALLENGE_INVALID');
  });
});
