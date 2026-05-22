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

const mockDeleteUserById = jest.fn();
const mockLookupPrimaryOrgId = jest.fn();
const mockAudit = jest.fn();
const mockRequireAdminContext = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  resolveUserFeatures: jest.fn(),
  isValidFeatureFlag: () => true,
  SYSTEM_ORG_ID: 'system',
}));

jest.mock('mongoose', () => {
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

jest.mock('../src/helpers/audit', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

// user-admin transitively imports utils/token via user-profile; mock so we
// don't pull in the real JWT signing path (which would demand env vars).
jest.mock('../src/utils/token', () => ({ issueTokens: jest.fn() }));
jest.mock('../src/utils/validation', () => ({
  validateBody: jest.fn(),
  updateProfileSchema: {},
  changePasswordSchema: {},
}));
jest.mock('../src/utils/pagination', () => ({ parsePagination: () => ({ offset: 0, limit: 25 }) }));

jest.mock('../src/helpers/controller-helper', () => ({
  requireAdminContext: (req: any, res: any) => mockRequireAdminContext(req, res),
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
}));

jest.mock('../src/services', () => ({
  userAdminService: {
    deleteUserById: (...a: unknown[]) => mockDeleteUserById(...a),
    lookupPrimaryOrgId: (...a: unknown[]) => mockLookupPrimaryOrgId(...a),
  },
  UA_USER_NOT_FOUND: 'UA_USER_NOT_FOUND',
  UA_USERNAME_TAKEN: 'UA_USERNAME_TAKEN',
  UA_EMAIL_TAKEN: 'UA_EMAIL_TAKEN',
  UA_OWNER_HAS_ORGS: 'UA_OWNER_HAS_ORGS',
  UA_ORG_NOT_FOUND: 'UA_ORG_NOT_FOUND',
}));

jest.mock('../src/config', () => ({ config: {} }));

import { bulkDeleteUsers } from '../src/controllers/user-admin';

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
  mockRequireAdminContext.mockReset();
});

describe('bulkDeleteUsers', () => {
  it('rejects org admins (sysadmin-only)', async () => {
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: true, isSuperAdmin: false });
    const req: any = { user: { sub: 'u1' }, body: { ids: ['a'] } };
    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockDeleteUserById).not.toHaveBeenCalled();
  });

  it('rejects empty / missing ids array', async () => {
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: false, isSuperAdmin: true });
    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'u1' }, body: {} },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects batches over 100 ids', async () => {
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: false, isSuperAdmin: true });
    const ids = Array.from({ length: 101 }, (_, i) => `u${i}`);
    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, body: { ids } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects non-string ids', async () => {
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: false, isSuperAdmin: true });
    const res = mockRes();
    await (bulkDeleteUsers as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, body: { ids: ['ok', 42 as unknown as string] } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('refuses to self-delete and continues with the rest', async () => {
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: false, isSuperAdmin: true });
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
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: false, isSuperAdmin: true });
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
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: false, isSuperAdmin: true });
    mockLookupPrimaryOrgId.mockResolvedValue(undefined);
    mockDeleteUserById
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('UA_OWNER_HAS_ORGS'));

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
    mockRequireAdminContext.mockReturnValue({ isOrgAdmin: false, isSuperAdmin: true });
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
