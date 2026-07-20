// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests that PUT /users/:id (admin edit of ANOTHER user) emits the
 * `admin.user.update` audit event on a role/email/password change — and that
 * the recorded `details` carry only the changed field NAMES, never the new
 * password (or any secret) value. A privileged account-takeover (admin resets
 * a victim's password / elevates their role) must leave a trail; a refactor
 * that silently drops this audit call should fail these tests loudly.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockRequireAdminContext = jest.fn<(...a: unknown[]) => unknown>();
const mockUpdateUserById = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockHasMembershipInOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockLookupPrimaryOrgId = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  resolveUserFeatures: jest.fn(() => ({})),
  isValidFeatureFlag: () => true,
  validateBulkArray: jest.fn(),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAdminContext: (...a: unknown[]) => mockRequireAdminContext(...a),
  // Pass-through wrapper — just run the handler (errorMap arg ignored).
  withController: (_label: string, fn: Function) => async (req: any, res: any) => fn(req, res),
}));

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { auth: { passwordMinLength: 8 } },
}));

jest.unstable_mockModule('../src/controllers/user-profile.js', () => ({
  formatUserResponse: (u: unknown) => u,
  toUserResponseInput: (u: unknown) => u,
  toOverridesRecord: (v: unknown) => v,
}));

jest.unstable_mockModule('../src/models/index.js', () => ({ Organization: { findById: jest.fn() } }));

jest.unstable_mockModule('../src/services/index.js', () => ({
  userAdminService: {
    updateUserById: (...a: unknown[]) => mockUpdateUserById(...a),
    hasMembershipInOrg: (...a: unknown[]) => mockHasMembershipInOrg(...a),
    lookupPrimaryOrgId: (...a: unknown[]) => mockLookupPrimaryOrgId(...a),
  },
  UA_USER_NOT_FOUND: 'UA_USER_NOT_FOUND',
  UA_USERNAME_TAKEN: 'UA_USERNAME_TAKEN',
  UA_EMAIL_TAKEN: 'UA_EMAIL_TAKEN',
  UA_OWNER_HAS_ORGS: 'UA_OWNER_HAS_ORGS',
  UA_ORG_NOT_FOUND: 'UA_ORG_NOT_FOUND',
  UA_SEAT_LIMIT: 'UA_SEAT_LIMIT',
  UA_CANNOT_CHANGE_OWNER: 'UA_CANNOT_CHANGE_OWNER',
  UA_ROLES_NEED_ORG: 'UA_ROLES_NEED_ORG',
  RL_ROLE_NOT_FOUND: 'RL_ROLE_NOT_FOUND',
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  adminCreateUserSchema: {},
  adminUpdateUserSchema: {},
  validateBody: (_schema: unknown, body: unknown) => body,
}));

const { updateUserById } = await import('../src/controllers/user-admin.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const run = (req: any, res: any) =>
  (updateUserById as unknown as (req: any, res: any) => Promise<void>)(req, res);

beforeEach(() => {
  jest.clearAllMocks();
  mockHasMembershipInOrg.mockResolvedValue(true);
  mockLookupPrimaryOrgId.mockResolvedValue('org-target');
});

describe('updateUserById audit — admin.user.update', () => {
  it('records admin.user.update with the changed field names (sysadmin cross-tenant)', async () => {
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: false, isSuperAdmin: true, adminType: 'system' });
    mockUpdateUserById.mockResolvedValue({
      user: { _id: 'victim' }, changes: ['email', 'role', 'password'], organizationName: 'Acme', activeOrgRole: 'admin',
    });

    const req: any = {
      user: { sub: 'admin-1', organizationId: 'sys-org', isSuperAdmin: true },
      params: { id: 'victim' },
      body: { email: 'attacker@evil.com', role: 'admin', password: 'Sup3rSecret!' },
    };
    await run(req, mockRes());

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.user.update', expect.objectContaining({
      targetType: 'user',
      targetId: 'victim',
      // affectedOrgId resolves to the target's primary org for a sysadmin.
      affectedOrgId: 'org-target',
      details: { changes: ['email', 'role', 'password'] },
    }));
  });

  it('NEVER puts the new password (or any secret) value in details — only field names', async () => {
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: false, isSuperAdmin: true, adminType: 'system' });
    mockUpdateUserById.mockResolvedValue({
      user: { _id: 'victim' }, changes: ['password'], organizationName: null, activeOrgRole: 'member',
    });

    const req: any = {
      user: { sub: 'admin-1', organizationId: 'sys-org', isSuperAdmin: true },
      params: { id: 'victim' },
      body: { password: 'Sup3rSecret!' },
    };
    await run(req, mockRes());

    const details = (mockAudit.mock.calls[0] as any)[2].details;
    expect(JSON.stringify(details)).not.toContain('Sup3rSecret!');
    expect(details.changes).toEqual(['password']);
  });

  it('uses the org-admin caller org as affectedOrgId', async () => {
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: true, isSuperAdmin: false, adminType: 'org' });
    mockUpdateUserById.mockResolvedValue({
      user: { _id: 'victim' }, changes: ['role'], organizationName: 'Acme', activeOrgRole: 'admin',
    });

    const req: any = {
      user: { sub: 'org-admin', organizationId: 'org-1' },
      params: { id: 'victim' },
      body: { role: 'admin' },
    };
    await run(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.user.update', expect.objectContaining({
      affectedOrgId: 'org-1',
      details: { changes: ['role'] },
    }));
    // Org-admin knows its own org — no primary-org lookup needed.
    expect(mockLookupPrimaryOrgId).not.toHaveBeenCalled();
  });

  it('does NOT emit an audit event when nothing changed (empty changes)', async () => {
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: true, isSuperAdmin: false, adminType: 'org' });
    mockUpdateUserById.mockResolvedValue({
      user: { _id: 'victim' }, changes: [], organizationName: 'Acme', activeOrgRole: 'member',
    });

    const req: any = {
      user: { sub: 'org-admin', organizationId: 'org-1' },
      params: { id: 'victim' },
      body: { role: 'member' },
    };
    await run(req, mockRes());

    expect(mockAudit).not.toHaveBeenCalled();
  });
});
