// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /auth/webauthn/login/verify` — a refused passkey sign-in is the same
 * opaque 401 the password path gives, and it says it is a CREDENTIAL refusal
 * (`INVALID_CREDENTIALS`), so no client mistakes it for an expired access token
 * and re-sends the assertion after a refresh.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const mockVerifyLogin = jest.fn<(...a: unknown[]) => Promise<unknown>>();
let mockUser: unknown = null;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn(), recordAuditEvent: jest.fn() }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/bootstrap-admin.js', () => ({ closeBootstrapExceptionOnEnrolment: jest.fn() }));
jest.unstable_mockModule('../src/helpers/sign-in.js', () => ({ completeInteractiveSignIn: jest.fn() }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ rejectIfSsoEnforced: async () => false }));
jest.unstable_mockModule('../src/models/index.js', () => ({ User: {} }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { findForTokenIssue: async () => mockUser },
}));
jest.unstable_mockModule('../src/services/mfa-enrolment.js', () => ({
  clearMfaNudgeOnEnrolment: jest.fn(), clearResetGraceOnEnrolment: jest.fn(),
}));
jest.unstable_mockModule('../src/services/recovery-codes-service.js', () => ({
  issueRecoveryCodesIfAbsent: jest.fn(), removeRecoveryCodesIfNoFactor: jest.fn(),
}));
jest.unstable_mockModule('../src/services/session/access-tokens.js', () => ({
  issueStepUpToken: jest.fn(), signInAuth: () => ({ amr: ['webauthn'], aal: 2, authTime: new Date(0) }),
}));
jest.unstable_mockModule('../src/services/webauthn-service.js', () => ({
  verifyLogin: (...a: unknown[]) => mockVerifyLogin(...a),
}));

const { loginVerify } = await import('../src/controllers/webauthn.js');
const { WEBAUTHN_COUNTER_REGRESSION, WEBAUTHN_VERIFICATION_FAILED } = await import('../src/services/webauthn-errors.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const req = () => ({
  body: { ceremonyId: 'cer-1', response: { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {} } },
  headers: {},
}) as any;

describe('POST /auth/webauthn/login/verify refusals', () => {
  it.each([
    ['a failed verification', () => mockVerifyLogin.mockRejectedValue(new Error(WEBAUTHN_VERIFICATION_FAILED))],
    ['a counter regression', () => mockVerifyLogin.mockRejectedValue(new Error(WEBAUTHN_COUNTER_REGRESSION))],
    ['an account that no longer exists', () => { mockUser = null; mockVerifyLogin.mockResolvedValue({ userId: 'u1', id: 'cred-1' }); }],
  ])('answers %s with 401 INVALID_CREDENTIALS', async (_name, arrange) => {
    arrange();
    const res = makeRes();

    await loginVerify(req(), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0]).toMatchObject({ message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
  });
});
