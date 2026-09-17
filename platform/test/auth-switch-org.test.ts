// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-scoped auth controllers:
 *  - `switchOrg` (POST /auth/switch-org) emits `org.switch` with the DESTINATION
 *    org as `affectedOrgId` and re-issues within the CURRENT refresh-session slot.
 *  - `refresh` revokes only the reused token's slot, never every session.
 *  - `logout` clears only the current slot.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockSwitchActiveOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRenewSessionTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRevokeRefreshSession = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockInvalidateAllSessions = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockFindForTokenIssue = jest.fn<(...a: unknown[]) => Promise<unknown>>();

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
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ findSsoEnforcementForEmail: async () => null, rejectIfSsoEnforced: async () => false }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_label: string, fn: Function) => async (req: any, res: any) => fn(req, res),
}));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/services/billing-provision.js', () => ({ provisionBillingSubscription: jest.fn() }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: {
    switchActiveOrg: (...a: unknown[]) => mockSwitchActiveOrg(...a),
    revokeRefreshSession: (...a: unknown[]) => mockRevokeRefreshSession(...a),
    invalidateAllSessions: (...a: unknown[]) => mockInvalidateAllSessions(...a),
    findForTokenIssue: (...a: unknown[]) => mockFindForTokenIssue(...a),
  },
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  signPersonalAccessToken: jest.fn(),
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
  renewSessionTokens: (...a: unknown[]) => mockRenewSessionTokens(...a),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, body: unknown) => body, registerSchema: {}, loginSchema: {}, refreshSchema: {}, completeOnboardingSchema: {}, joinOrgSchema: {},
}));

const { switchOrg, refresh, logout } = await import('../src/controllers/auth.js');

function makeRes() {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIssueTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  mockRenewSessionTokens.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
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

describe('switchOrg — session slot', () => {
  it('re-issues within the caller\'s refresh-session slot instead of opening a new one', async () => {
    const user = { _id: 'u1' };
    mockSwitchActiveOrg.mockResolvedValue(user);
    const res = makeRes();
    await (switchOrg as any)({ user: { sub: 'u1', organizationId: 'org-from', sid: 's1' }, body: { organizationId: 'org-to' } }, res);

    expect(mockRenewSessionTokens).toHaveBeenCalledWith(user, 'org-to', { sessionId: 's1' });
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('401s when the caller\'s slot is gone', async () => {
    mockSwitchActiveOrg.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockResolvedValue(null);
    const res = makeRes();
    await (switchOrg as any)({ user: { sub: 'u1', sid: 's1' }, body: { organizationId: 'org-to' } }, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('refresh — reuse revokes one slot', () => {
  it('rotates the presented token\'s slot', async () => {
    const user = { _id: 'u1' };
    mockFindForTokenIssue.mockResolvedValue(user);
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    await (refresh as any)({ user: { sub: 'u1', organizationId: 'org-1' }, body: { refreshToken: 'rt' } }, res);

    expect(mockRenewSessionTokens).toHaveBeenCalledWith(user, 'org-1', { sessionId: 's1', presentedToken: 'rt' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('on a rotation miss revokes ONLY that slot — never every session', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockResolvedValue(null);
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    await (refresh as any)({ user: { sub: 'u1' }, body: { refreshToken: 'old' } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockRevokeRefreshSession).toHaveBeenCalledWith('u1', 's1');
    expect(mockInvalidateAllSessions).not.toHaveBeenCalled();
  });
});

describe('logout — current slot only', () => {
  it('revokes the access token\'s slot and nothing else', async () => {
    const res = makeRes();
    await (logout as any)({ user: { sub: 'u1', sid: 's1' }, body: {} }, res);
    expect(mockRevokeRefreshSession).toHaveBeenCalledWith('u1', 's1');
    expect(mockInvalidateAllSessions).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
