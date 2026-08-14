// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit test for `switchOrg` (POST /auth/switch-org). Pivoting the active org
 * changes the actor's session scope, so it emits `org.switch` with the
 * DESTINATION org as `affectedOrgId` (so it surfaces in that org's audit view)
 * and the from/to ids in details. No audit fires on the not-a-member 403 path.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockSwitchActiveOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  createSafeClient: () => ({ post: jest.fn(), delete: jest.fn() }),
  isSystemOrgId: () => false,
}));

jest.unstable_mockModule('../src/config/index.js', () => ({ config: { billing: { enabled: false }, compliance: { enabled: false } } }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
// controllers/auth now imports SSO login enforcement, which pulls in the org-idp /
// secret-blob / entitlement chain. This suite tests switchOrg, not SSO — mock the
// helper so that chain isn't loaded (avoids needing its transitive api-core exports).
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ findSsoEnforcementForEmail: async () => null }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_label: string, fn: Function) => async (req: any, res: any) => fn(req, res),
}));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/services/billing-provision.js', () => ({ provisionBillingSubscription: jest.fn() }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { switchActiveOrg: (...a: unknown[]) => mockSwitchActiveOrg(...a) },
  DUPLICATE_CREDENTIALS: 'DUPLICATE_CREDENTIALS',
  RESERVED_ORG_NAME: 'RESERVED_ORG_NAME',
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({ signPersonalAccessToken: jest.fn(), issueTokens: (...a: unknown[]) => mockIssueTokens(...a) }));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: jest.fn(), registerSchema: {}, loginSchema: {}, refreshSchema: {},
}));

const { switchOrg } = await import('../src/controllers/auth.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIssueTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
});

describe('switchOrg — org.switch audit', () => {
  it('emits org.switch with destination org as affectedOrgId and from/to in details', async () => {
    mockSwitchActiveOrg.mockResolvedValue({ _id: 'u1', lastActiveOrgId: 'org-to' });

    const req: any = { user: { sub: 'u1', organizationId: 'org-from' }, body: { organizationId: 'org-to' } };
    const res = makeRes();
    await (switchOrg as any)(req, res);

    expect(mockAudit).toHaveBeenCalledWith(req, 'org.switch', expect.objectContaining({
      affectedOrgId: 'org-to',
      details: { fromOrgId: 'org-from', toOrgId: 'org-to' },
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does NOT audit when the user is not an active member (403)', async () => {
    mockSwitchActiveOrg.mockResolvedValue(null);

    const res = makeRes();
    await (switchOrg as any)({ user: { sub: 'u1', organizationId: 'org-from' }, body: { organizationId: 'org-x' } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
