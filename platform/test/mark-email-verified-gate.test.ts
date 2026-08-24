// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * markEmailVerified authorization gate (POST /auth/mark-email-verified).
 *
 * SECURITY: this endpoint self-asserts the caller's email as verified with no
 * emailed round-trip, and `isEmailVerified` is the sole proof-of-control the
 * domain-based-join flow trusts. Because every self-registered user is `owner`
 * of their personal org, the old admin/owner gate reduced to "anyone can
 * self-verify" — a cross-tenant auto-join hole. The gate must now accept ONLY a
 * superadmin; every non-superadmin (owner/admin/member) must be 403'd BEFORE the
 * service call.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockMarkVerified = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown, message?: string) => res.status(status).json({ success: true, statusCode: status, data, message }),
  createSafeClient: () => ({ post: jest.fn(), delete: jest.fn() }),
  isSystemOrgId: () => false,
}));

jest.unstable_mockModule('../src/config/index.js', () => ({ config: { billing: { enabled: false }, compliance: { enabled: false } } }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ findSsoEnforcementForEmail: async () => null, rejectIfSsoEnforced: async () => false }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_label: string, fn: Function) => async (req: any, res: any) => fn(req, res),
}));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/services/billing-provision.js', () => ({ provisionBillingSubscription: jest.fn() }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { markEmailVerifiedById: (...a: unknown[]) => mockMarkVerified(...a) },
  DUPLICATE_CREDENTIALS: 'DUPLICATE_CREDENTIALS',
  RESERVED_ORG_NAME: 'RESERVED_ORG_NAME',
  ONBOARDING_USER_NOT_FOUND: 'ONBOARDING_USER_NOT_FOUND',
  ONBOARDING_NO_ORG: 'ONBOARDING_NO_ORG',
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({ signPersonalAccessToken: jest.fn(), issueTokens: jest.fn() }));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: jest.fn(), registerSchema: {}, loginSchema: {}, refreshSchema: {}, completeOnboardingSchema: {}, joinOrgSchema: {},
}));

const { markEmailVerified } = await import('../src/controllers/auth.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMarkVerified.mockResolvedValue({ id: 'u1' });
});

describe('markEmailVerified — superadmin-only gate', () => {
  it('lets a superadmin self-verify (marks + audits)', async () => {
    const req: any = { user: { sub: 'u1', isSuperAdmin: true, role: 'owner' } };
    const res = makeRes();
    await (markEmailVerified as any)(req, res);

    expect(mockMarkVerified).toHaveBeenCalledWith('u1');
    expect(mockAudit).toHaveBeenCalledWith(req, 'user.email.verified', expect.objectContaining({ targetId: 'u1' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each([['owner'], ['admin'], ['member']])('403s a non-superadmin %s BEFORE any service call', async (role) => {
    const res = makeRes();
    await (markEmailVerified as any)({ user: { sub: 'u9', isSuperAdmin: false, role } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockMarkVerified).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller', async () => {
    const res = makeRes();
    await (markEmailVerified as any)({}, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockMarkVerified).not.toHaveBeenCalled();
  });
});
