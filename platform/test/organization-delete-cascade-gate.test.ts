// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the SOFT-DELETE / restore controller flow.
 *
 * `DELETE /organization/:id` no longer runs the destructive cascade inline — it
 * soft-deletes (snapshot + tombstone + session cut via `softDeleteOrg`) and
 * returns 202 with the purge deadline. The fail-closed cascade now lives in the
 * purge sweep (see org-purge.test.ts). `POST /organization/:id/restore` reverses
 * a soft-delete within the window.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSoftDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRestore = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockExpandOrgScope = jest.fn<(...a: unknown[]) => Promise<string[]>>();
const mockCanAdminister = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockAudit = jest.fn();
const mockGetTeamParent = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockListDeletedTeams = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockMove = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockGetById = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
  isServicePrincipal: () => false,
  isSystemAdmin: (req: any) => req?.user?.isSuperAdmin === true,
  sendError: (res: any, status: number, message: string, code?: string, details?: unknown) =>
    res.status(status).json({ success: false, message, code, details }),
  sendSuccess: (res: any, status: number, data: unknown, message?: string) =>
    res.status(status).json({ success: true, statusCode: status, data, message }),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireSystemAdmin: (_req: any, _res: any) => true,
  requireAuth: (_req: any, _res: any) => true,
  canAccessOrg: async () => true,
  canAdministerOrg: (...a: unknown[]) => mockCanAdminister(...a),
  withController: (_label: string, fn: Function, errorMap?: Record<string, { status: number; message: string }>) =>
    async (req: any, res: any) => {
      try {
        await fn(req, res);
      } catch (err: any) {
        // Mirror withController's errorMap behaviour so throw-based typed errors
        // (ORG_SNAPSHOT_FAILED, ...) map to the right status in these tests.
        const mapped = errorMap?.[err?.message];
        if (mapped) return res.status(mapped.status).json({ success: false, message: mapped.message });
        return res.status(500).json({ success: false, message: 'error' });
      }
    },
}));

jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  expandOrgScope: (...a: unknown[]) => mockExpandOrgScope(...a),
}));

jest.unstable_mockModule('../src/helpers/seats.js', () => ({ pooledSeatUsage: jest.fn(), pooledFeatureEntitlements: jest.fn() }));

jest.unstable_mockModule('../src/services/index.js', () => ({
  organizationService: {
    delete: (...a: unknown[]) => mockDelete(...a),
    restore: (...a: unknown[]) => mockRestore(...a),
    getById: (...a: unknown[]) => mockGetById(...a),
  },
  orgHierarchyService: {
    getTeamParent: (...a: unknown[]) => mockGetTeamParent(...a),
    listDeletedTeams: (...a: unknown[]) => mockListDeletedTeams(...a),
    move: (...a: unknown[]) => mockMove(...a),
  },
  changedAiProviderFields: () => [],
}));

jest.unstable_mockModule('../src/services/org-cascade-service.js', () => ({
  softDeleteOrg: (...a: unknown[]) => mockSoftDelete(...a),
  exportOrg: jest.fn(),
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: jest.fn(),
  createOrganizationSchema: {},
  updateOrganizationSchema: {},
  updateOrgIdentitySchema: {},
}));

const {
  deleteOrganization, restoreOrganization, deleteTeam, listDeletedTeams, moveOrganization, getOrganizationById,
} = await import('../src/controllers/organization.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const req = () => ({ user: { sub: 'admin-1', organizationId: 'sysorg' }, params: { id: 'org-acme' }, body: {} });

beforeEach(() => {
  jest.clearAllMocks();
  mockExpandOrgScope.mockResolvedValue(['org-acme']); // flat org, no teams
  mockCanAdminister.mockResolvedValue(true);
});

describe('deleteOrganization — soft-delete', () => {
  it('soft-deletes (202 + org.soft_delete audit) and does NOT run the destructive cascade', async () => {
    const purgeAfter = new Date(Date.now() + 7 * 86400_000);
    mockSoftDelete.mockResolvedValue({ orgId: 'org-acme', deletedAt: new Date(), purgeAfter, snapshotId: 'snap-1', membersInvalidated: 3 });
    const res = mockRes();

    await (deleteOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    // Soft-delete was invoked with (orgId, actorOrgId, deletedBy).
    expect(mockSoftDelete).toHaveBeenCalledWith('org-acme', 'sysorg', 'admin-1');
    // No inline hard delete.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.soft_delete', expect.objectContaining({ affectedOrgId: 'org-acme' }));
  });

  it('blocks a root org that still has live teams (400, no soft-delete)', async () => {
    mockExpandOrgScope.mockResolvedValue(['org-acme', 'team-1']);
    const res = mockRes();

    await (deleteOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(mockSoftDelete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    // The message names the routes that actually exist: delete the team, or move it.
    expect((res.json.mock.calls[0] as any)[0].message).toMatch(/delete each team, or move it/);
  });

  it('maps a snapshot failure to 502 and does NOT audit a delete that did not happen', async () => {
    mockSoftDelete.mockRejectedValue(new Error('ORG_SNAPSHOT_FAILED'));
    const res = mockRes();

    await (deleteOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('restoreOrganization', () => {
  it('restores within the window (200 + org.restore audit)', async () => {
    mockRestore.mockResolvedValue({ id: 'org-acme', name: 'Acme', membersInvalidated: 3 });
    const res = mockRes();

    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    // Passes the acting admin's id so restore excludes them from the member
    // token-invalidation (restoring an org must not log out the restorer).
    expect(mockRestore).toHaveBeenCalledWith('org-acme', 'admin-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.restore', expect.objectContaining({ affectedOrgId: 'org-acme' }));
  });

  it('404s when the org was already purged (nothing to restore)', async () => {
    mockRestore.mockResolvedValue(null);
    const res = mockRes();

    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('403s a caller who does not administer the org', async () => {
    mockCanAdminister.mockResolvedValue(false);
    const res = mockRes();

    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockRestore).not.toHaveBeenCalled();
  });
});

describe('restoreOrganization — team restore refusals', () => {
  it.each([
    ['ORG_RESTORE_PARENT_GONE', 409],
    ['ORG_RESTORE_PARENT_INELIGIBLE', 409],
    ['ORG_SEAT_LIMIT', 409],
  ])('maps %s to %i and does not audit', async (code, status) => {
    mockRestore.mockRejectedValue(new Error(code));
    const res = mockRes();

    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('deleteTeam — parent admin soft-deletes its own team', () => {
  const teamReq = () => ({ user: { sub: 'admin-1', organizationId: 'root-1' }, params: { id: 'root-1', teamId: 'team-1' }, body: {} });

  it('soft-deletes via the shared path (202 + org.team.delete audit naming the parent)', async () => {
    mockGetTeamParent.mockResolvedValue({ parentOrgId: 'root-1' });
    const purgeAfter = new Date(Date.now() + 7 * 86400_000);
    mockSoftDelete.mockResolvedValue({ orgId: 'team-1', deletedAt: new Date(), purgeAfter, snapshotId: 'snap-9', membersInvalidated: 2 });
    const res = mockRes();

    await (deleteTeam as any)(teamReq(), res);

    expect(mockCanAdminister).toHaveBeenCalledWith(expect.anything(), 'root-1');
    expect(mockSoftDelete).toHaveBeenCalledWith('team-1', 'root-1', 'admin-1');
    expect(res.status).toHaveBeenCalledWith(202);
    expect((res.json.mock.calls[0] as any)[0].data).toEqual(expect.objectContaining({ purgeAfter, snapshotId: 'snap-9' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.team.delete', expect.objectContaining({
      targetId: 'team-1',
      affectedOrgId: 'team-1',
      details: expect.objectContaining({ parentOrgId: 'root-1', membersInvalidated: 2 }),
    }));
  });

  it('404s when the team is not a direct team of :id (or does not exist)', async () => {
    for (const parent of [{ parentOrgId: 'other-root' }, { parentOrgId: null }, null]) {
      jest.clearAllMocks();
      mockCanAdminister.mockResolvedValue(true);
      mockGetTeamParent.mockResolvedValue(parent);
      const res = mockRes();
      await (deleteTeam as any)(teamReq(), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockSoftDelete).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    }
  });

  it('403s a caller who does not administer the parent', async () => {
    mockCanAdminister.mockResolvedValue(false);
    const res = mockRes();
    await (deleteTeam as any)(teamReq(), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetTeamParent).not.toHaveBeenCalled();
  });

  it('maps an already-deleted team to 409', async () => {
    mockGetTeamParent.mockResolvedValue({ parentOrgId: 'root-1' });
    mockSoftDelete.mockRejectedValue(new Error('ORG_ALREADY_DELETED'));
    const res = mockRes();
    await (deleteTeam as any)(teamReq(), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('listDeletedTeams', () => {
  it('returns the service result for an org the caller administers', async () => {
    const teams = [{ orgId: 'team-1', orgName: 'Blue', deletedAt: new Date(), purgeAfter: new Date() }];
    mockListDeletedTeams.mockResolvedValue({ teams });
    const res = mockRes();
    await (listDeletedTeams as any)({ user: { sub: 'a' }, params: { id: 'root-1' } }, res);
    expect(mockListDeletedTeams).toHaveBeenCalledWith('root-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json.mock.calls[0] as any)[0].data).toEqual({ teams });
  });

  it('403s a caller who does not administer :id', async () => {
    mockCanAdminister.mockResolvedValue(false);
    const res = mockRes();
    await (listDeletedTeams as any)({ user: { sub: 'a' }, params: { id: 'root-1' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockListDeletedTeams).not.toHaveBeenCalled();
  });
});

describe('moveOrganization — sysadmin reparent', () => {
  const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const moveReq = (parentOrgId: unknown) => ({ user: { sub: 'sys-1' }, params: { id: 'team-1' }, body: { parentOrgId } });

  it('moves, audits admin.org.move, and returns the updated org DTO', async () => {
    mockMove.mockResolvedValue({ orgId: 'team-1', fromParentOrgId: 'old-root', toParentOrgId: ROOT, tier: 'team', membersInvalidated: 4 });
    const dto = { id: 'team-1', parentOrgId: ROOT, parentOrgName: 'New', teams: [] };
    mockGetById.mockResolvedValue(dto);
    const res = mockRes();

    await (moveOrganization as any)(moveReq(ROOT), res);

    expect(mockMove).toHaveBeenCalledWith('team-1', ROOT);
    expect(mockGetById).toHaveBeenCalledWith('team-1', { includeHierarchy: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json.mock.calls[0] as any)[0].data).toEqual({ organization: dto });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'admin.org.move', expect.objectContaining({
      targetId: 'team-1',
      details: { fromParentOrgId: 'old-root', toParentOrgId: ROOT, tier: 'team', membersInvalidated: 4 },
    }));
  });

  it('accepts null (make standalone)', async () => {
    mockMove.mockResolvedValue({ orgId: 'team-1', fromParentOrgId: ROOT, toParentOrgId: null, tier: 'team', membersInvalidated: 0 });
    mockGetById.mockResolvedValue({ id: 'team-1', parentOrgId: null, teams: [] });
    const res = mockRes();
    await (moveOrganization as any)(moveReq(null), res);
    expect(mockMove).toHaveBeenCalledWith('team-1', null);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each([[undefined], ['not-an-id'], [42]])('400s a malformed parentOrgId (%p) without moving', async (bad) => {
    const res = mockRes();
    await (moveOrganization as any)(moveReq(bad), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockMove).not.toHaveBeenCalled();
  });

  it.each([
    ['ORG_MOVE_SELF', 400],
    ['ORG_MOVE_CYCLE', 400],
    ['ORG_MOVE_HAS_TEAMS', 400],
    ['ORG_MOVE_TARGET_NOT_ROOT', 400],
    ['ORG_MOVE_TARGET_TIER', 400],
    ['ORG_MOVE_NOOP', 400],
    ['ORG_MOVE_SYSTEM', 400],
    ['ORG_MOVE_TARGET_NOT_FOUND', 404],
    ['ORG_NOT_FOUND', 404],
    ['ORG_MOVE_DELETED', 409],
    ['ORG_SEAT_LIMIT', 409],
  ])('maps %s to %i and does not audit', async (code, status) => {
    mockMove.mockRejectedValue(new Error(code));
    const res = mockRes();
    await (moveOrganization as any)(moveReq(ROOT), res);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('getOrganizationById — hierarchy for sysadmins', () => {
  it('asks for the parent name + live teams only when the caller is a sysadmin', async () => {
    mockGetById.mockResolvedValue({ id: 'org-acme' });
    const get = (isSuperAdmin: boolean) => (getOrganizationById as any)(
      { user: { sub: 'u', isSuperAdmin }, params: { id: 'org-acme' }, query: {} }, mockRes(),
    );

    await get(true);
    expect(mockGetById).toHaveBeenLastCalledWith('org-acme', expect.objectContaining({ includeHierarchy: true }));
    await get(false);
    expect(mockGetById).toHaveBeenLastCalledWith('org-acme', expect.objectContaining({ includeHierarchy: false }));
  });
});
