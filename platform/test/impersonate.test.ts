// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `impersonateUser` controller. The controller's contract:
 * sysadmin gate, refuse self-impersonation, refuse chained impersonation,
 * refuse impersonating another sysadmin, audit the start event, and
 * return a token issued by `issueImpersonationToken`.
 */

const mockUserFindById = jest.fn();
const mockRequireSystemAdmin = jest.fn();
const mockIssueImpersonation = jest.fn();
const mockAudit = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
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
jest.mock('../src/helpers/controller-helper', () => ({
  requireSystemAdmin: (req: any, res: any) => mockRequireSystemAdmin(req, res),
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
}));
jest.mock('../src/models', () => ({
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
}));
jest.mock('../src/utils/token', () => ({
  issueImpersonationToken: (...a: unknown[]) => mockIssueImpersonation(...a),
}));

import { impersonateUser } from '../src/controllers/impersonate';

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockUserFindById.mockReset();
  mockRequireSystemAdmin.mockReset().mockReturnValue(true);
  mockIssueImpersonation.mockReset();
  mockAudit.mockReset();
});

describe('impersonateUser', () => {
  it('returns 403 path when not a sysadmin', async () => {
    mockRequireSystemAdmin.mockImplementation((_req: any, res: any) => {
      res.status(403).json({ success: false });
      return false;
    });
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'u1' }, params: { userId: 'target' } }, res,
    );
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
  });

  it('refuses to impersonate from within an existing impersonation session', async () => {
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'u1', impersonatorId: 'orig' }, params: { userId: 'target' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
  });

  it('refuses self-impersonation', async () => {
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'u1' }, params: { userId: 'u1' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when target does not exist', async () => {
    // Controller now does `User.findById(...).select('+isSuperAdmin')` to opt
    // into a `select: false` field — mock must return a thenable-on-.select().
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, params: { userId: 'missing' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('refuses to impersonate another sysadmin', async () => {
    mockUserFindById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: 'other-sysadmin', isSuperAdmin: true }),
    });
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, params: { userId: 'other-sysadmin' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
  });

  it('issues a token and audits the start event on the happy path', async () => {
    mockUserFindById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: 'target', isSuperAdmin: false }),
    });
    mockIssueImpersonation.mockResolvedValue({ accessToken: 'imp.jwt', expiresIn: 900 });

    const req: any = { user: { sub: 'sysadmin' }, params: { userId: 'target' } };
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(req, res);

    expect(mockIssueImpersonation).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'target' }),
      'sysadmin',
    );
    // The impersonator at session start IS the actor (the sysadmin), already
    // captured as the event's actorId — so it's no longer duplicated into
    // `details`. Events performed LATER under the issued token carry the
    // sysadmin in the first-class `impersonatorId` field instead.
    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.impersonate.start', expect.objectContaining({
      targetType: 'user',
      targetId: 'target',
      details: expect.objectContaining({ expiresIn: 900 }),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ accessToken: 'imp.jwt', expiresIn: 900, targetUserId: 'target' }),
    }));
  });
});
