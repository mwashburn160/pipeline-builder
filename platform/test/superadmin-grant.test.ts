// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * superadmin grant/revoke controller tests.
 *
 * Under the single-source model the controller delegates the actual grant/revoke
 * to `roles-service` (`grantPlatformAdmin`/`revokePlatformAdmin`), which assigns
 * or removes the system-org Super Admin Role and recomputes — so the flag and
 * `recomputeUserOrgRole` can never diverge. These tests assert the controller's
 * orchestration: sysadmin gate, self-revoke guard, 404, idempotency (audit only
 * on a real change), and that it calls the service (not a direct flag write).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUserFindById = jest.fn();
const mockRequireSystemAdmin = jest.fn();
const mockAudit = jest.fn();
const mockGrantPlatformAdmin = jest.fn<() => Promise<{ changed: boolean }>>();
const mockRevokePlatformAdmin = jest.fn<() => Promise<{ changed: boolean }>>();

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
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  grantPlatformAdmin: (...a: unknown[]) => mockGrantPlatformAdmin(...(a as [])),
  revokePlatformAdmin: (...a: unknown[]) => mockRevokePlatformAdmin(...(a as [])),
}));

const { addUserGrant, removeUserGrant } = await import('../src/controllers/superadmin.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

/** `User.findById(id).select('email')` → the user's email (or null for 404). */
const findsUser = (email: string | null) =>
  mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(email ? { email } : null) });

beforeEach(() => {
  mockUserFindById.mockReset();
  findsUser('target@example.com');
  mockRequireSystemAdmin.mockReset().mockReturnValue(true);
  mockAudit.mockReset();
  mockGrantPlatformAdmin.mockReset().mockResolvedValue({ changed: true });
  mockRevokePlatformAdmin.mockReset().mockResolvedValue({ changed: true });
});

describe('addUserGrant (POST /api/admin/users/:id/grants)', () => {
  it('delegates to grantPlatformAdmin and audits on a real change', async () => {
    const req: any = { user: { sub: 'admin' }, params: { id: 'target' }, body: { grant: 'platform-admin' } };
    const res = mockRes();
    await (addUserGrant as unknown as (req: any, res: any) => Promise<void>)(req, res);

    // The grant goes through the Super Admin Role service, NOT a direct flag write.
    expect(mockGrantPlatformAdmin).toHaveBeenCalledWith('target');
    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.superadmin.grant', expect.objectContaining({
      targetType: 'user',
      targetId: 'target',
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ grant: 'platform-admin', changed: true }),
    }));
  });

  it('is an idempotent no-op (no audit) when the service reports changed:false', async () => {
    mockGrantPlatformAdmin.mockResolvedValue({ changed: false });
    const res = mockRes();
    await (addUserGrant as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'admin' }, params: { id: 'target' }, body: { grant: 'platform-admin' } },
      res,
    );

    expect(mockGrantPlatformAdmin).toHaveBeenCalledWith('target');
    expect(mockAudit).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ changed: false }),
    }));
  });

  it('404s (no grant attempted) when the user does not exist', async () => {
    findsUser(null);
    const res = mockRes();
    await (addUserGrant as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'admin' }, params: { id: 'ghost' }, body: { grant: 'platform-admin' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGrantPlatformAdmin).not.toHaveBeenCalled();
  });
});

describe('removeUserGrant (DELETE /api/admin/users/:id/grants)', () => {
  it('delegates to revokePlatformAdmin and audits on a real change', async () => {
    const req: any = { user: { sub: 'admin' }, params: { id: 'target' }, body: { grant: 'platform-admin' } };
    const res = mockRes();
    await (removeUserGrant as unknown as (req: any, res: any) => Promise<void>)(req, res);

    expect(mockRevokePlatformAdmin).toHaveBeenCalledWith('target');
    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.superadmin.revoke', expect.objectContaining({
      targetType: 'user',
      targetId: 'target',
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ grant: 'platform-admin', changed: true }),
    }));
  });

  it('refuses self-revoke and never touches the service', async () => {
    const res = mockRes();
    await (removeUserGrant as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'me' }, params: { id: 'me' }, body: { grant: 'platform-admin' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockRevokePlatformAdmin).not.toHaveBeenCalled();
  });

  it('is an idempotent no-op (no audit) when the service reports changed:false', async () => {
    mockRevokePlatformAdmin.mockResolvedValue({ changed: false });
    const res = mockRes();
    await (removeUserGrant as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'admin' }, params: { id: 'target' }, body: { grant: 'platform-admin' } },
      res,
    );

    expect(mockRevokePlatformAdmin).toHaveBeenCalledWith('target');
    expect(mockAudit).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ changed: false }),
    }));
  });
});
