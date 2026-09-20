// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The credential-minting handlers with a permission SUBSET ("Selected
 * permissions"): `POST /user/keys` and `POST /user/generate-token` validate it
 * against the creator's current permissions, store/carry it, and audit it; a
 * machine-session renewal keeps the slot's subset; and sign-out-everywhere's
 * replacement session inherits a restricted caller's narrowing.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockCreateKey = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ accessToken: 'a.jwt', refreshToken: 'r', expiresIn: 60 }));
const mockRenewSessionTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ accessToken: 'a.jwt', refreshToken: 'r', expiresIn: 60 }));
const mockFindRefreshSession = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => undefined);
let rolePermissions: string[] = ['pipelines:read', 'pipelines:write', 'plugins:read'];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  refuseForOrgAdminAssurance: () => false,
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/client-info.js', () => ({ clientInfoOf: () => ({ ip: '10.0.0.1' }) }));
jest.unstable_mockModule('../src/helpers/session-cookie.js', () => ({
  deliverSessionTokens: (_q: unknown, _s: unknown, t: { accessToken: string }) => ({ accessToken: t.accessToken }),
  clearRefreshCookie: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/services/index.js', () => ({
  userProfileService: {
    findForTokenIssue: async () => ({ _id: 'u1', lastActiveOrgId: 'org-1', tokenVersion: 1 }),
    revokeAllSessions: async () => ({ _id: 'u1', lastActiveOrgId: 'org-1', tokenVersion: 2 }),
  },
  apiKeyService: { create: (...a: unknown[]) => mockCreateKey(...a) },
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: () => ({ select: () => ({ lean: async () => ({ _id: 'u1', lastActiveOrgId: 'org-1' }) }) }) },
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  findRefreshSession: (...a: unknown[]) => mockFindRefreshSession(...a),
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
  renewSessionTokens: (...a: unknown[]) => mockRenewSessionTokens(...a),
  membershipForOrg: async () => ({ organizationId: 'org-1', role: 'member', rolePermissions }),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, body: unknown) => body,
  updateProfileSchema: {},
  changePasswordSchema: {},
}));

const { createAccessKey, generateToken, revokeAllTokens } = await import('../src/controllers/user-profile.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
const person = { sub: 'u1', sid: 'slot-1', permissions: ['pipelines:read', 'pipelines:write', 'plugins:read'], amr: ['pwd'], aal: 1, auth_time: 0 };
const call = async (handler: unknown, req: any) => {
  const res = mockRes();
  await (handler as (q: any, s: any) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  rolePermissions = ['pipelines:read', 'pipelines:write', 'plugins:read'];
  mockFindRefreshSession.mockResolvedValue({ id: 'slot-1', kind: 'interactive' });
  mockCreateKey.mockImplementation(async () => ({ key: 'pb_pat_x', view: { id: 'k1', prefix: 'pb_pat', permissions: ['pipelines:read'] } }));
});

describe('POST /user/keys with a permission subset', () => {
  it('stores the normalized subset and audits it', async () => {
    const res = await call(createAccessKey, { user: person, body: { name: 'ci', permissions: ['plugins:read', 'pipelines:read'] }, headers: {} });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreateKey).toHaveBeenCalledWith('u1', expect.objectContaining({ permissions: ['pipelines:read', 'plugins:read'] }), expect.anything());
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.key.create', expect.objectContaining({
      details: expect.objectContaining({ permissions: ['pipelines:read', 'plugins:read'] }),
    }));
  });

  it('omitted → full access (no subset stored, none audited)', async () => {
    await call(createAccessKey, { user: person, body: { name: 'ci' }, headers: {} });
    const input = mockCreateKey.mock.calls[0][1] as Record<string, unknown>;
    expect(input.permissions).toBeUndefined();
    const details = (mockAudit.mock.calls[0][2] as { details: Record<string, unknown> }).details;
    expect(details.permissions).toBeUndefined();
  });

  it('refuses a permission the creator does not currently hold (403) and mints nothing', async () => {
    const res = await call(createAccessKey, { user: person, body: { name: 'ci', permissions: ['billing:manage'] }, headers: {} });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PERMISSION_SUBSET_EXCEEDS' }));
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('refuses a subset combined with a capability scope (400)', async () => {
    const res = await call(createAccessKey, { user: person, body: { name: 'ci', scope: 'registry:push', permissions: ['plugins:read'] }, headers: {} });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });
});

describe('POST /user/generate-token with a permission subset', () => {
  it('OPENS a machine session carrying the subset', async () => {
    await call(generateToken, { user: person, body: { permissions: ['pipelines:read'] }, headers: {} });
    expect(mockIssueTokens).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({ kind: 'machine', permissions: ['pipelines:read'] }));
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.token.create', expect.objectContaining({
      details: expect.objectContaining({ session: 'opened', permissions: ['pipelines:read'] }),
    }));
  });

  it('a restricted caller (an exchanged subset key) can only mint its own narrowing', async () => {
    const restricted = { sub: 'u1', permissionsRestricted: true, permissions: ['plugins:read'], amr: ['pwd'], aal: 1, auth_time: 0 };
    mockFindRefreshSession.mockResolvedValue(undefined);
    await call(generateToken, { user: restricted, body: {}, headers: {} });
    expect(mockIssueTokens).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({ permissions: ['plugins:read'] }));

    const res = await call(generateToken, { user: restricted, body: { permissions: ['pipelines:write'] }, headers: {} });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('RENEWING a machine session passes a requested subset through for the slot check', async () => {
    mockFindRefreshSession.mockResolvedValue({ id: 'slot-1', kind: 'machine' });
    await call(generateToken, { user: person, body: { permissions: ['pipelines:read'] }, headers: {} });
    expect(mockRenewSessionTokens).toHaveBeenCalledWith(
      expect.anything(), 'org-1', { sessionId: 'slot-1', kind: 'machine' }, expect.objectContaining({ permissions: ['pipelines:read'] }),
    );
    mockRenewSessionTokens.mockClear();
    await call(generateToken, { user: person, body: {}, headers: {} });
    expect((mockRenewSessionTokens.mock.calls[0][3] as Record<string, unknown>).permissions).toBeUndefined();
  });
});

describe('POST /user/tokens/revoke-all', () => {
  it('the replacement session inherits a restricted caller\'s narrowing', async () => {
    const restricted = { sub: 'u1', permissionsRestricted: true, permissions: ['plugins:read'], amr: ['pwd'], aal: 1, auth_time: 0 };
    await call(revokeAllTokens, { user: restricted, body: {}, headers: {} });
    expect(mockIssueTokens).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({ kind: 'interactive', permissions: ['plugins:read'] }));
  });
});
