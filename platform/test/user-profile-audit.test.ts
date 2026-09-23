// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests that the user-profile handlers emit the right audit events.
 *
 * These calls were added so security reviewers can find auth-factor
 * changes in the audit log. A refactor that silently drops the audit
 * call should fail these tests loudly.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockAudit = jest.fn<AnyFn>();
const mockUpdateProfile = jest.fn<AnyFn>();
const mockChangePassword = jest.fn<AnyFn>();
const mockFindForTokenIssue = jest.fn<AnyFn>();
const mockIssueTokens = jest.fn<AnyFn>();
const mockRenewSessionTokens = jest.fn<AnyFn>();
// The caller's own slot: `undefined` (no slot — a PAT), an interactive slot (a
// person, whose call opens a NEW machine slot), or a machine slot (renewed in place).
const mockFindRefreshSession = jest.fn<AnyFn>();
const mockValidateBody = jest.fn((_schema: unknown, body: unknown) => body);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, ...(code ? { code } : {}) }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  resolveUserFeatures: jest.fn<AnyFn>(),
  resolveUserPermissions: jest.fn(() => []),
}));

jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    pre() { /* no-op */ }
    post() { /* no-op */ }
    virtual() { return this; }
    set() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  const model = jest.fn<AnyFn>();
  // `default` + `Document` matter: models/user.ts (reached through
  // utils/validation) imports mongoose's default export and the Document type.
  return { Types: { ObjectId: class {} }, Schema, Document: class {}, models: {}, model, default: { Schema, model, models: {} } };
});

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

jest.unstable_mockModule('../src/services/index.js', () => ({
  userProfileService: {
    updateProfile: (...a: unknown[]) => mockUpdateProfile(...a),
    changePassword: (...a: unknown[]) => mockChangePassword(...a),
    findForTokenIssue: (...a: unknown[]) => mockFindForTokenIssue(...a),
  },
  // Linking stub: the access-key handlers live in the same controller.
  apiKeyService: {},
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  User: {},
  Organization: {},
  UserOrganization: {},
}));

jest.unstable_mockModule('../src/services/session/access-tokens.js', () => ({
  enforceOrgAssurance: async (_u: unknown, _m: unknown, a: unknown) => a,
  // Session-auth helpers the controllers now import (see utils/token.ts).
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
}));
jest.unstable_mockModule('../src/services/session/refresh-sessions.js', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  findRefreshSession: (...a: unknown[]) => mockFindRefreshSession(...a),
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
  renewSessionTokens: (...a: unknown[]) => mockRenewSessionTokens(...a),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (schema: unknown, body: unknown, _res: unknown) => mockValidateBody(schema, body),
  updateProfileSchema: {},
  changePasswordSchema: {},
}));

const mockPasswordPolicyForPerson = jest.fn(async (..._a: unknown[]) => ({ minLength: 8 }));
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  PASSWORD_MAX_LENGTH: 128,
  passwordPolicyForPerson: (...a: unknown[]) => mockPasswordPolicyForPerson(...a),
}));

const { changePassword, updateUser, getOwnPasswordPolicy } = await import('../src/controllers/user-profile.js');
const { generateToken } = await import('../src/controllers/user-credentials.js');


function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockAudit.mockReset();
  mockUpdateProfile.mockReset();
  mockChangePassword.mockReset();
  mockFindForTokenIssue.mockReset();
  mockIssueTokens.mockReset();
  mockRenewSessionTokens.mockReset();
  mockFindRefreshSession.mockReset();
  mockFindRefreshSession.mockResolvedValue(undefined);
  mockValidateBody.mockImplementation((_s: unknown, body: unknown) => body);
});

describe('updateUser audit', () => {
  it('records user.profile.update with the changed field names', async () => {
    mockUpdateProfile.mockResolvedValue({ user: { _id: 'u1', username: 'a', email: 'a@b' }, organizationName: null, activeOrgRole: null });
    const req: any = { user: { sub: 'u1' }, body: { email: 'new@example.com', username: 'newname' } };
    await (updateUser as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'user.profile.update', expect.objectContaining({
      targetType: 'user',
      targetId: 'u1',
      details: { fields: ['email', 'username'] },
    }));
  });

  it('does NOT log the actual values — only the field names', async () => {
    mockUpdateProfile.mockResolvedValue({ user: { _id: 'u1' } });
    const req: any = { user: { sub: 'u1' }, body: { email: 'secret@private.com' } };
    await (updateUser as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());

    const auditDetails = mockAudit.mock.calls[0][2].details;
    expect(JSON.stringify(auditDetails)).not.toContain('secret@private.com');
    expect(auditDetails.fields).toEqual(['email']);
  });
});

describe('changePassword audit', () => {
  it('records user.password.change on success', async () => {
    mockChangePassword.mockResolvedValue(undefined);
    const req: any = { user: { sub: 'u1' }, body: { currentPassword: 'x', newPassword: 'y' } };
    await (changePassword as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'user.password.change', expect.objectContaining({
      targetType: 'user',
      targetId: 'u1',
    }));
  });

  it('does NOT emit an audit event if changePassword threw (service failure path)', async () => {
    mockChangePassword.mockRejectedValue(new Error('PROFILE_INVALID_CREDENTIALS'));
    const req: any = { user: { sub: 'u1' }, body: { currentPassword: 'x', newPassword: 'y' } };
    const res = mockRes();
    // `withController` runs FOR REAL now (see helpers/controller-helper-mock.ts),
    // so the throw does not escape the handler: it is answered through the
    // controller's own error map, which turns PROFILE_INVALID_CREDENTIALS into a
    // 401. Asserting the MAPPED response is the production behaviour; the point
    // of the test — nothing is audited on the failure path — is unchanged.
    await (changePassword as unknown as (req: any, res: any) => Promise<void>)(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  // Negative: the handler's own gate. `requireAuthUserId` refuses a request with
  // no authenticated subject before the service is called or anything audited.
  it('401s a caller with no authenticated user, without touching the service', async () => {
    const res = mockRes();
    await (changePassword as unknown as (req: any, res: any) => Promise<void>)(
      { user: undefined, body: { currentPassword: 'x', newPassword: 'y' } } as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockChangePassword).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('generateToken audit', () => {
  it('records user.token.create with the actual expiresIn', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1', lastActiveOrgId: 'org-1' });
    mockIssueTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
    mockFindRefreshSession.mockResolvedValue({ id: 's1', kind: 'interactive' });

    const req: any = { user: { sub: 'u1', sid: 's1' }, headers: {}, body: { expiresIn: '86400' } };
    await (generateToken as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'user.token.create', expect.objectContaining({
      targetType: 'user',
      targetId: 'u1',
      // A person's call OPENS a machine session (it never touches their login).
      // The access token is short-lived; the credential's lifetime is the slot's.
      details: { expiresIn: 900, lifetimeSeconds: 86400, session: 'opened' },
    }));
  });
});

describe('generateToken — machine sessions', () => {
  const user = { _id: 'u1', lastActiveOrgId: 'org-1' };
  const run = (req: any, res = mockRes()) => {
    const promise = (generateToken as unknown as (req: any, res: any) => Promise<void>)({ headers: {}, ...req }, res);
    return promise.then(() => res);
  };

  it('renews a MACHINE caller in place — a renewal can never move the slot\'s fixed end', async () => {
    mockFindForTokenIssue.mockResolvedValue(user);
    mockFindRefreshSession.mockResolvedValue({ id: 's1', kind: 'machine' });
    mockRenewSessionTokens.mockResolvedValue({ accessToken: 'a', expiresIn: 3600 });

    await run({ user: { sub: 'u1', sid: 's1' }, body: { expiresIn: '3600', scope: 'reporting:ingest' } });

    expect(mockRenewSessionTokens).toHaveBeenCalledWith(
      user, 'org-1', { sessionId: 's1', kind: 'machine' },
      expect.objectContaining({ scope: 'reporting:ingest' }),
    );
    expect(mockRenewSessionTokens.mock.calls[0][3]).not.toHaveProperty('expiresIn');
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('opens a NEW machine slot for an INTERACTIVE caller, leaving their login alone', async () => {
    mockFindForTokenIssue.mockResolvedValue(user);
    mockFindRefreshSession.mockResolvedValue({ id: 's1', kind: 'interactive' });
    mockIssueTokens.mockResolvedValue({ accessToken: 'a', expiresIn: 900 });

    await run({ user: { sub: 'u1', sid: 's1' }, body: {} });

    expect(mockIssueTokens).toHaveBeenCalledWith(user, 'org-1', expect.objectContaining({ kind: 'machine' }));
    expect(mockRenewSessionTokens).not.toHaveBeenCalled();
  });

  it.each([
    ['an exchanged access key (PAT)', { sub: 'u1', jti: 'pat-1', token_use: 'api_key' }],
    ['a service account', { sub: 'sa-1', jti: 'key-1', token_use: 'api_key', principalType: 'service_account' }],
    ['an impersonation session', { sub: 'u1', jti: 'imp-1', token_use: 'access', impersonatorId: 'op-1' }],
    ['a token with no slot at all', { sub: 'u1', token_use: 'access' }],
  ])('REFUSES to derive a machine credential from %s (403 SESSION_SLOT_REQUIRED)', async (_label, principal) => {
    mockFindForTokenIssue.mockResolvedValue(user);

    const res = await run({ user: principal, body: {} });

    // Revoking the key / ending the impersonation must not leave a long-lived
    // credential behind.
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'SESSION_SLOT_REQUIRED' });
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(mockRenewSessionTokens).not.toHaveBeenCalled();
  });

  it('refuses a caller whose named slot is gone (revoked or evicted)', async () => {
    mockFindForTokenIssue.mockResolvedValue(user);
    mockFindRefreshSession.mockResolvedValue(undefined);

    const res = await run({ user: { sub: 'u1', sid: 'gone' }, body: {} });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(mockRenewSessionTokens).not.toHaveBeenCalled();
  });
});

describe('generateToken — the org\'s "administrative actions require MFA" policy', () => {
  const user = { _id: 'u1', lastActiveOrgId: 'org-1' };
  const run = (req: any, res = mockRes()) => {
    const promise = (generateToken as unknown as (req: any, res: any) => Promise<void>)({ headers: {}, method: 'POST', ...req }, res);
    return promise.then(() => res);
  };
  const person = (aal: 1 | 2) => ({ sub: 'u1', sid: 's1', principalType: 'user', token_use: 'access', aal, org_admin_aal: 2 });

  it('refuses a single-factor person OPENING a new machine credential (401 MFA_REQUIRED)', async () => {
    mockFindForTokenIssue.mockResolvedValue(user);
    mockFindRefreshSession.mockResolvedValue({ id: 's1', kind: 'interactive' });

    const res = await run({ user: person(1), body: {} });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('lets an MFA-grade person open one', async () => {
    mockFindForTokenIssue.mockResolvedValue(user);
    mockFindRefreshSession.mockResolvedValue({ id: 's1', kind: 'interactive' });
    mockIssueTokens.mockResolvedValue({ accessToken: 'a', expiresIn: 900 });

    await run({ user: person(2), body: {} });

    expect(mockIssueTokens).toHaveBeenCalled();
  });

  it('refuses a PAT minting a machine credential while the policy is on (403)', async () => {
    mockFindForTokenIssue.mockResolvedValue(user);

    const res = await run({ user: { sub: 'u1', jti: 'pat-1', principalType: 'user', token_use: 'api_key', aal: 2, org_admin_aal: 2 }, body: {} });

    // Refused before the policy is even consulted: a key never derives a session.
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'SESSION_SLOT_REQUIRED' });
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('keeps RENEWING an existing machine credential — unattended renewal must survive the policy', async () => {
    mockFindForTokenIssue.mockResolvedValue(user);
    mockFindRefreshSession.mockResolvedValue({ id: 's1', kind: 'machine' });
    mockRenewSessionTokens.mockResolvedValue({ accessToken: 'a', expiresIn: 3600 });

    await run({ user: person(1), body: {} });

    expect(mockRenewSessionTokens).toHaveBeenCalled();
  });
});

describe('getOwnPasswordPolicy', () => {
  it('answers the strictest minimum across the caller\'s orgs (what change-password enforces)', async () => {
    mockPasswordPolicyForPerson.mockResolvedValueOnce({ minLength: 14, orgId: 'org-strict' } as never);
    const res = mockRes();
    await (getOwnPasswordPolicy as unknown as (req: any, res: any) => Promise<void>)({ user: { sub: 'u1' } }, res);
    expect(mockPasswordPolicyForPerson).toHaveBeenCalledWith('u1');
    expect(res.status).toHaveBeenCalledWith(200);
    // Which org sets it is not the caller's business here — only the number.
    expect(res.json.mock.calls[0][0].data).toEqual({ minLength: 14, maxLength: 128 });
  });
});
