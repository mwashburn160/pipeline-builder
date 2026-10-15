// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /auth/register with an `invitationToken` joins the INVITING org — it
 * must not set up an org of its own around the new account.
 *
 * authService.register accepts the invitation inline (see
 * register-from-invitation tests in auth-service.test.ts); this covers the
 * controller's half: no billing subscription and no compliance auto-subscribe
 * for an org that was never created, and the membership grant audited as
 * `invitation.accept`, exactly as POST /invitation/accept audits it. A plain
 * signup keeps both hooks.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockRegister = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockProvisionBilling = jest.fn<AnyFn>();
const mockCompliancePost = jest.fn<AnyFn>(async () => ({ statusCode: 200 }));
const mockAudit = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  isSystemOrgId: () => false,
  createSafeClient: () => ({ post: (...a: unknown[]) => mockCompliancePost(...a) }),
  getServiceAuthHeader: () => 'Bearer svc',
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ billing: { enabled: true }, compliance: { enabled: true } }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ rejectIfSsoEnforced: async () => false }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/services/billing-provision.js', () => ({ provisionBillingSubscription: (...a: unknown[]) => mockProvisionBilling(...a) }));
jest.unstable_mockModule('../src/services/superadmin-bootstrap.js', () => ({ maybePromoteNewUser: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  assertNewPasswordAcceptable: async () => undefined,
  invitationOrgForRegistration: async () => 'acme-org',
  passwordShortfall: async () => null,
}));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { register: (...a: unknown[]) => mockRegister(...a) },
  auditService: { createEvent: jest.fn(async () => undefined) },
}));
jest.unstable_mockModule('../src/services/session/access-tokens.js', () => ({
  enforceOrgAssurance: async (_u: unknown, _m: unknown, a: unknown) => a,
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
}));
jest.unstable_mockModule('../src/services/session/refresh-sessions.js', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  issueTokens: jest.fn<AnyFn>(),
  renewSessionTokens: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, body: unknown) => body, registerSchema: {}, loginSchema: {}, completeOnboardingSchema: {}, joinOrgSchema: {},
}));

const { register } = await import('../src/controllers/auth.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}

const body = { username: 'newbie', email: 'new@example.com', password: 'Passw0rdPassw0rd' };
/** Let the fire-and-forget hooks (billing, compliance) run before asserting on them. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /auth/register — signing up from an invitation', () => {
  it('joins the inviting org: no billing, no compliance auto-subscribe, the grant audited as invitation.accept', async () => {
    mockRegister.mockResolvedValue({
      sub: 'u9',
      email: 'new@example.com',
      role: 'member',
      organizationId: 'acme-org',
      organizationName: 'Acme',
      invitation: { invitationId: 'inv-1', role: 'member' },
    });
    const res = makeRes();

    await (register as any)({ body: { ...body, invitationToken: 'tok-1' }, headers: {} }, res);
    await settle();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockProvisionBilling).not.toHaveBeenCalled();
    expect(mockCompliancePost).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'invitation.accept', expect.objectContaining({
      targetType: 'invitation',
      targetId: 'inv-1',
      affectedOrgId: 'acme-org',
      details: expect.objectContaining({ email: 'new@example.com', role: 'member', userId: 'u9' }),
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.register', expect.anything());
  });

  it('a plain signup still provisions its new org (billing + compliance)', async () => {
    mockRegister.mockResolvedValue({
      sub: 'u9',
      email: 'new@example.com',
      role: 'owner',
      organizationId: 'own-org',
      organizationName: 'newbie',
      planId: 'developer',
    });
    const res = makeRes();

    await (register as any)({ body, headers: {} }, res);
    await settle();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockProvisionBilling).toHaveBeenCalledWith('own-org', 'developer');
    expect(mockCompliancePost).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalledWith(expect.anything(), 'invitation.accept', expect.anything());
  });
});
