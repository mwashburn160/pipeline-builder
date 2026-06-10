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
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockAudit = jest.fn();
const mockUpdateProfile = jest.fn();
const mockChangePassword = jest.fn();
const mockFindForTokenIssue = jest.fn();
const mockIssueTokens = jest.fn();
const mockValidateBody = jest.fn((_schema: unknown, body: unknown) => body);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  resolveUserFeatures: jest.fn(),
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
  return { Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAuthUserId: (req: any) => req.user?.sub,
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  PROFILE_USER_NOT_FOUND: 'PROFILE_USER_NOT_FOUND',
  PROFILE_EMAIL_TAKEN: 'PROFILE_EMAIL_TAKEN',
  PROFILE_INVALID_CREDENTIALS: 'PROFILE_INVALID_CREDENTIALS',
  PROFILE_OWNER_HAS_ORGS: 'PROFILE_OWNER_HAS_ORGS',
  userProfileService: {
    updateProfile: (...a: unknown[]) => mockUpdateProfile(...a),
    changePassword: (...a: unknown[]) => mockChangePassword(...a),
    findForTokenIssue: (...a: unknown[]) => mockFindForTokenIssue(...a),
  },
}));

jest.unstable_mockModule('../src/models/index.js', () => ({ User: {}, Organization: {}, UserOrganization: {} }));

jest.unstable_mockModule('../src/utils/token.js', () => ({ issueTokens: (...a: unknown[]) => mockIssueTokens(...a) }));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (schema: unknown, body: unknown, _res: unknown) => mockValidateBody(schema, body),
  updateProfileSchema: {},
  changePasswordSchema: {},
}));

const { changePassword, generateToken, updateUser } = await import('../src/controllers/user-profile.js');


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
    await expect(
      (changePassword as unknown as (req: any, res: any) => Promise<void>)(req, mockRes()),
    ).rejects.toThrow();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('generateToken audit', () => {
  it('records user.token.create with the actual expiresIn', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1', lastActiveOrgId: 'org-1' });
    mockIssueTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 86400 });

    const req: any = { user: { sub: 'u1' }, body: { expiresIn: '86400' } };
    await (generateToken as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'user.token.create', expect.objectContaining({
      targetType: 'user',
      targetId: 'u1',
      details: { expiresIn: 86400 },
    }));
  });
});
