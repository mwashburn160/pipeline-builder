// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the user-grant admin endpoints (`addUserGrant` / `removeUserGrant`).
 *
 * Security regression lock-in: granting/revoking the `platform-admin` grant
 * must not only flip `User.isSuperAdmin`, it must ALSO invalidate any live
 * session the target holds — `$inc: { tokenVersion: 1 }` (so a stale JWT is
 * rejected by requireAuth) and `$unset: { refreshToken: '' }`. Without this,
 * a demoted user keeps admin access until their token expires, and a promoted
 * user's new grant doesn't take effect until re-login.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUserFindById = jest.fn();
const mockUserUpdateOne = jest.fn();
const mockRequireSystemAdmin = jest.fn();
const mockAudit = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireSystemAdmin: (req: any, res: any) => mockRequireSystemAdmin(req, res),
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {
    findById: (...a: unknown[]) => mockUserFindById(...a),
    updateOne: (...a: unknown[]) => mockUserUpdateOne(...a),
  },
}));

const { addUserGrant, removeUserGrant } = await import('../src/controllers/superadmin.js');


function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

/** A mongoose-doc-ish user with a spyable `.save()`, returned via `.select()`. */
function userDoc(over: Record<string, unknown> = {}) {
  return {
    email: 'target@example.com',
    isSuperAdmin: false,
    save: jest.fn(async () => undefined),
    ...over,
  };
}

/** The session-invalidation write both endpoints must issue on a real transition. */
const SESSION_INVALIDATION = { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } };

beforeEach(() => {
  mockUserFindById.mockReset();
  mockUserUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  mockRequireSystemAdmin.mockReset().mockReturnValue(true);
  mockAudit.mockReset();
});

describe('addUserGrant (POST /api/admin/users/:id/grants)', () => {
  it('grants platform-admin AND bumps tokenVersion + clears refreshToken', async () => {
    const doc = userDoc({ isSuperAdmin: false });
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });

    const req: any = { user: { sub: 'admin' }, params: { id: 'target' }, body: { grant: 'platform-admin' } };
    const res = mockRes();
    await (addUserGrant as unknown as (req: any, res: any) => Promise<void>)(req, res);

    // Grant flips the flag ...
    expect(doc.isSuperAdmin).toBe(true);
    expect(doc.save).toHaveBeenCalledTimes(1);
    // ... AND invalidates live sessions so the promotion takes effect now.
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'target' }, SESSION_INVALIDATION);
    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.superadmin.grant', expect.objectContaining({
      targetType: 'user',
      targetId: 'target',
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ grant: 'platform-admin', changed: true }),
    }));
  });

  it('is an idempotent no-op (no tokenVersion bump) when already a sysadmin', async () => {
    const doc = userDoc({ isSuperAdmin: true });
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });

    const res = mockRes();
    await (addUserGrant as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'admin' }, params: { id: 'target' }, body: { grant: 'platform-admin' } },
      res,
    );

    // No transition → no session-invalidation write, no audit event.
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ changed: false }),
    }));
  });
});

describe('removeUserGrant (DELETE /api/admin/users/:id/grants)', () => {
  it('revokes platform-admin AND bumps tokenVersion + clears refreshToken', async () => {
    const doc = userDoc({ isSuperAdmin: true });
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });

    const req: any = { user: { sub: 'admin' }, params: { id: 'target' }, body: { grant: 'platform-admin' } };
    const res = mockRes();
    await (removeUserGrant as unknown as (req: any, res: any) => Promise<void>)(req, res);

    // Revoke flips the flag ...
    expect(doc.isSuperAdmin).toBe(false);
    expect(doc.save).toHaveBeenCalledTimes(1);
    // ... AND invalidates live sessions so a stale JWT can't retain admin.
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'target' }, SESSION_INVALIDATION);
    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.superadmin.revoke', expect.objectContaining({
      targetType: 'user',
      targetId: 'target',
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ grant: 'platform-admin', changed: true }),
    }));
  });

  it('refuses self-revoke and does not invalidate the session', async () => {
    const res = mockRes();
    await (removeUserGrant as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'me' }, params: { id: 'me' }, body: { grant: 'platform-admin' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it('is an idempotent no-op (no tokenVersion bump) when not a sysadmin', async () => {
    const doc = userDoc({ isSuperAdmin: false });
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });

    const res = mockRes();
    await (removeUserGrant as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'admin' }, params: { id: 'target' }, body: { grant: 'platform-admin' } },
      res,
    );

    expect(mockUserUpdateOne).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ changed: false }),
    }));
  });
});
