// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registration runs the org password policy + breached-password check before
 * creating anything — and a registration that is accepting an invitation
 * answers to the INVITING org's policy.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type */
const mockRegister = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
  sub: 'u9', email: 'new@example.com', organizationId: 'own-org', organizationName: 'new',
}));
const mockAssertAcceptable = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockInvitationOrg = jest.fn<(...a: unknown[]) => Promise<string | undefined>>(async () => 'inviting-org');

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  isSystemOrgId: () => false,
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { billing: { enabled: false }, compliance: { enabled: false } } }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ rejectIfSsoEnforced: async () => false }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/services/billing-provision.js', () => ({ provisionBillingSubscription: jest.fn() }));
jest.unstable_mockModule('../src/services/superadmin-bootstrap.js', () => ({ maybePromoteNewUser: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  assertNewPasswordAcceptable: (...a: unknown[]) => mockAssertAcceptable(...a),
  invitationOrgForRegistration: (...a: unknown[]) => mockInvitationOrg(...a),
  passwordShortfall: async () => null,
}));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { register: (...a: unknown[]) => mockRegister(...a) },
  auditService: { createEvent: jest.fn(async () => undefined) },
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  issueTokens: jest.fn(),
  renewSessionTokens: jest.fn(),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, body: unknown) => body, registerSchema: {}, loginSchema: {}, completeOnboardingSchema: {}, joinOrgSchema: {},
}));

const { register } = await import('../src/controllers/auth.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
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

const body = { username: 'newbie', email: 'new@example.com', password: 'Passw0rdPassw0rd' };

beforeEach(() => jest.clearAllMocks());

describe('POST /auth/register — password policy', () => {
  it('checks a plain signup against the platform rules and the breach list only', async () => {
    const res = makeRes();
    await (register as any)({ body, headers: {} }, res);
    expect(mockInvitationOrg).not.toHaveBeenCalled();
    expect(mockAssertAcceptable).toHaveBeenCalledWith('Passw0rdPassw0rd', {});
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('a signup accepting an invitation answers to the INVITING org\'s policy', async () => {
    const res = makeRes();
    await (register as any)({ body: { ...body, invitationToken: 'tok-1' }, headers: {} }, res);
    expect(mockInvitationOrg).toHaveBeenCalledWith('tok-1', 'new@example.com');
    expect(mockAssertAcceptable).toHaveBeenCalledWith('Passw0rdPassw0rd', { extraOrgIds: ['inviting-org'] });
  });

  it('a refused password creates nothing', async () => {
    mockAssertAcceptable.mockRejectedValueOnce(policyRefusal('PASSWORD_BREACHED', 'breached'));
    const res = makeRes();
    await (register as any)({ body, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('PASSWORD_BREACHED');
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
