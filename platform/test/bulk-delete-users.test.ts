// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `bulkDeleteUsers` (POST /users/bulk-delete).
 *
 * The controller's contract: validate batch shape, reject org admins,
 * delete each id and continue on error, audit per success, never
 * self-delete, never accept a batch over 100. Each branch matters
 * because operators run this against real prod data and partial
 * failures must surface item-by-item.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockDeleteUserById = jest.fn();
const mockLookupPrimaryOrgId = jest.fn();
const mockAudit = jest.fn();
const mockRequireScope = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  resolveUserFeatures: jest.fn(),
  resolveUserPermissions: jest.fn(() => []),
  isValidFeatureFlag: () => true,
  // `validateBulkArray` is the shared guard used by all bulk endpoints.
  // Mirror api-core's behaviour: empty/non-array → error; over cap → error;
  // otherwise return { value }.
  validateBulkArray: jest.fn((value: unknown, fieldName: string, maxItems?: number) => {
    if (!Array.isArray(value) || value.length === 0) {
      return { error: `Request body must include a non-empty "${fieldName}" array` };
    }
    if (maxItems !== undefined && value.length > maxItems) {
      return { error: `Maximum ${maxItems} items per bulk operation` };
    }
    return { value };
  }),
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

// user-admin now imports the Organization model + toOrgId (to source an org's
// purchased feature entitlements for the get/update-features responses). Not
// exercised by bulk-delete, but the import must resolve.
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })) },
  UserPreferences: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })) },
  Organization: { findById: jest.fn() },
  // Linking stub only — the barrel's `User` is pulled in transitively by the
  // profile helpers the user-admin controller imports.
  User: {},
}));

// user-admin transitively imports utils/token via user-profile; mock so we
// don't pull in the real JWT signing path (which would demand env vars).
jest.unstable_mockModule('../src/utils/token.js', () => ({
  // Session-auth helpers the controllers now import (see utils/token.ts).
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  findRefreshSession: jest.fn(async () => undefined),
  signApiKeyToken: jest.fn(),
  signServiceAccountToken: jest.fn(),
  membershipForOrg: jest.fn(async () => undefined),
  issueTokens: jest.fn(),
  renewSessionTokens: jest.fn(),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: jest.fn(),
  updateProfileSchema: {},
  changePasswordSchema: {},
  adminUpdateUserSchema: {},
  adminCreateUserSchema: {},
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireMemberManagementScope: (req: any, res: any) => mockRequireScope(req, res),
  canManageOrgScope: async () => true,
  isOrgAdmin: () => false,
  // Consumed transitively via user-admin.js -> user-profile.js.
  requireAuthUserId: jest.fn(),
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  userAdminService: {
    deleteUserById: (...a: unknown[]) => mockDeleteUserById(...a),
    lookupPrimaryOrgId: (...a: unknown[]) => mockLookupPrimaryOrgId(...a),
  },
  // Consumed transitively via user-admin.js -> user-profile.js.
  userProfileService: {},
  // Consumed transitively via user-admin.js -> user-profile.js.
  apiKeyService: {},
}));

jest.unstable_mockModule('../src/config/index.js', () => ({ config: {} }));

const { bulkDeleteUsers, deleteUserById } = await import('../src/controllers/user-admin.js');


function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockDeleteUserById.mockReset();
  mockLookupPrimaryOrgId.mockReset();
  mockAudit.mockReset();
  mockRequireScope.mockReset();
});

describe('bulkDeleteUsers', () => {
  it('rejects org admins (sysadmin-only)', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: false, orgId: 'org-1' });
    const req: any = { user: { sub: 'u1' }, body: { ids: ['a'] } };
    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockDeleteUserById).not.toHaveBeenCalled();
  });

  it('rejects empty / missing ids array', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: true });
    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'u1' }, body: {} },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects batches over 100 ids', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: true });
    const ids = Array.from({ length: 101 }, (_, i) => `u${i}`);
    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, body: { ids } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects non-string ids', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: true });
    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, body: { ids: ['ok', 42 as unknown as string] } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('refuses to self-delete and continues with the rest', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: true });
    mockLookupPrimaryOrgId.mockResolvedValue('org-1');
    mockDeleteUserById.mockResolvedValue(undefined);

    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'me' }, body: { ids: ['me', 'someone-else'] } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(payload.summary).toEqual({ requested: 2, deleted: 1, failed: 1 });
    expect(payload.results[0]).toEqual({ id: 'me', ok: false, error: 'Cannot delete your own account' });
    expect(payload.results[1]).toEqual({ id: 'someone-else', ok: true, affectedOrgId: 'org-1' });
    expect(mockDeleteUserById).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserById).toHaveBeenCalledWith('someone-else');
  });

  it('audits each successful delete with bulk=true marker', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: true });
    mockLookupPrimaryOrgId.mockResolvedValue('org-9');
    mockDeleteUserById.mockResolvedValue(undefined);

    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, body: { ids: ['x', 'y'] } },
      res,
    );

    expect(mockAudit).toHaveBeenCalledTimes(2);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      'admin.user.delete',
      expect.objectContaining({ targetId: 'x', affectedOrgId: 'org-9', details: { bulk: true } }),
    );
  });

  it('records mapped error messages for known service errors', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: true });
    mockLookupPrimaryOrgId.mockResolvedValue(undefined);
    mockDeleteUserById
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('USER_OWNER_HAS_ORGS'));

    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, body: { ids: ['ok', 'owner'] } },
      res,
    );

    const payload = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(payload.summary).toEqual({ requested: 2, deleted: 1, failed: 1 });
    expect(payload.results[1].ok).toBe(false);
    expect(payload.results[1].error).toMatch(/owner/i);
  });

  it('falls through to raw error text on unknown errors', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: true });
    mockLookupPrimaryOrgId.mockResolvedValue(undefined);
    mockDeleteUserById.mockRejectedValue(new Error('mongo timeout'));

    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, body: { ids: ['x'] } },
      res,
    );

    const payload = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(payload.results[0].error).toBe('mongo timeout');
  });
});

describe('deleteUserById — deleting an account is platform-admin only', () => {
  it('refuses an org admin, even for a member of their own organization', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: false, orgId: 'org-1' });
    const res = mockRes();
    await (deleteUserById as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'org-admin', organizationId: 'org-1' }, params: { id: 'member' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockDeleteUserById).not.toHaveBeenCalled();
  });

  it('lets a platform admin delete an account', async () => {
    mockRequireScope.mockReturnValue({ isSuperAdmin: true });
    mockLookupPrimaryOrgId.mockResolvedValue('org-9');
    mockDeleteUserById.mockResolvedValue(undefined);
    const res = mockRes();
    await (deleteUserById as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'root' }, params: { id: 'member' } }, res,
    );
    expect(mockDeleteUserById).toHaveBeenCalledWith('member');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'admin.user.delete', expect.objectContaining({ affectedOrgId: 'org-9' }));
  });
});
