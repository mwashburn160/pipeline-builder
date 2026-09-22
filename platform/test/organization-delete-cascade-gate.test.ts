// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the SOFT-DELETE / restore controller flow.
 *
 * `DELETE /organization/:id` does not run the destructive cascade inline — it
 * soft-deletes (snapshot + tombstone + session cut via `softDeleteOrg`) and
 * returns 202 with the purge deadline. The fail-closed cascade lives in the
 * purge sweep (see org-purge.test.ts). `POST /organization/:id/restore` reverses
 * a soft-delete within the window.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSoftDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRestore = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockExpandOrgScope = jest.fn<(...a: unknown[]) => Promise<string[]>>();
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

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

// `canManageOrgScope` runs FOR REAL and lazily imports this module on the
// CROSS-ORG branch, so `isAncestorOrg` must be present (default: flat tree).
const mockIsAncestorOrg = jest.fn<(...a: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  expandOrgScope: (...a: unknown[]) => mockExpandOrgScope(...a),
  isAncestorOrg: (...a: unknown[]) => mockIsAncestorOrg(...a),
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

/**
 * `controller-helper` runs FOR REAL (see helpers/controller-helper-mock.ts), so
 * every gate below is satisfied by the REQUEST FIXTURE, never by a stub:
 *   - `requireSystemAdmin` (DELETE /:id, POST /:id/move) → `isSuperAdmin: true`
 *   - `canManageOrgScope`  (restore, deleteTeam, listDeletedTeams) → the
 *     caller's active org is (an ancestor of) the org named in `params.id`; the
 *     `org:settings` capability is the route's `requirePermission`
 *   - `canAccessOrg`       (GET /:id) → any member of that same org
 */
/** Platform administrator; `organizationId` is their own org, not the target. */
const SYSADMIN = { sub: 'admin-1', organizationId: 'sysorg', isSuperAdmin: true };
/** Admin/owner of `org-acme` — the org these routes target. */
const ACME_ADMIN = { sub: 'admin-1', organizationId: 'org-acme', role: 'admin' };
/** Signed-in member of `org-acme`, no admin authority anywhere. */
const ACME_MEMBER = { sub: 'u9', organizationId: 'org-acme' };

const req = (user: unknown = SYSADMIN) => ({ user, params: { id: 'org-acme' }, body: {} });

beforeEach(() => {
  jest.clearAllMocks();
  mockExpandOrgScope.mockResolvedValue(['org-acme']); // flat org, no teams
  mockIsAncestorOrg.mockResolvedValue(false); // flat tree unless a test says otherwise
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

  it('401s an anonymous caller and 403s a non-sysadmin org admin, without soft-deleting', async () => {
    const anon = mockRes();
    await (deleteOrganization as unknown as (req: any, res: any) => Promise<void>)(req(null), anon);
    expect(anon.status).toHaveBeenCalledWith(401);

    const orgAdmin = mockRes();
    await (deleteOrganization as unknown as (req: any, res: any) => Promise<void>)(req(ACME_ADMIN), orgAdmin);
    expect(orgAdmin.status).toHaveBeenCalledWith(403);

    expect(mockSoftDelete).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
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

  it('403s a caller outside the org\'s scope', async () => {
    const res = mockRes();

    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req({ sub: 'x', organizationId: 'org-other', role: 'admin' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('admits a non-admin of the org whose custom Role delegates org:settings', async () => {
    const res = mockRes();
    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(
      req({ ...ACME_MEMBER, role: 'member', permissions: ['org:settings'] }), res,
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mockRestore).toHaveBeenCalled();
  });

  it('401s an anonymous caller', async () => {
    const res = mockRes();
    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req(null), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('lets an org admin (not just a sysadmin) restore their OWN org', async () => {
    mockRestore.mockResolvedValue({ id: 'org-acme', name: 'Acme', membersInvalidated: 0 });
    const res = mockRes();
    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req(ACME_ADMIN), res);
    expect(res.status).toHaveBeenCalledWith(200);
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
  /** Admin/owner of the PARENT org (`:id`) — the gate's target on this route. */
  const ROOT_ADMIN = { sub: 'admin-1', organizationId: 'root-1', role: 'admin' };
  const teamReq = (user: unknown = ROOT_ADMIN) => ({ user, params: { id: 'root-1', teamId: 'team-1' }, body: {} });

  it('soft-deletes via the shared path (202 + org.team.delete audit naming the parent)', async () => {
    mockGetTeamParent.mockResolvedValue({ parentOrgId: 'root-1' });
    const purgeAfter = new Date(Date.now() + 7 * 86400_000);
    mockSoftDelete.mockResolvedValue({ orgId: 'team-1', deletedAt: new Date(), purgeAfter, snapshotId: 'snap-9', membersInvalidated: 2 });
    const res = mockRes();

    await (deleteTeam as any)(teamReq(), res);

    // The caller administers root-1 and nothing else, so reaching 202 is itself
    // the proof the gate is evaluated against the PARENT (`:id`) — see the
    // 'gates on the PARENT org' case below for the converse.
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
      mockGetTeamParent.mockResolvedValue(parent);
      const res = mockRes();
      await (deleteTeam as any)(teamReq(), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockSoftDelete).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    }
  });

  it('403s a caller outside the parent\'s scope', async () => {
    const res = mockRes();
    await (deleteTeam as any)(teamReq({ sub: 'u9', organizationId: 'other-root', role: 'admin' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetTeamParent).not.toHaveBeenCalled();
  });

  it('gates on the PARENT org, not the team — an admin of team-1 alone is refused', async () => {
    const res = mockRes();
    await (deleteTeam as any)(teamReq({ sub: 'team-admin', organizationId: 'team-1', role: 'admin' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetTeamParent).not.toHaveBeenCalled();
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller', async () => {
    const res = mockRes();
    await (deleteTeam as any)(teamReq(null), res);
    expect(res.status).toHaveBeenCalledWith(401);
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
    await (listDeletedTeams as any)({ user: { sub: 'a', organizationId: 'root-1', role: 'admin' }, params: { id: 'root-1' } }, res);
    expect(mockListDeletedTeams).toHaveBeenCalledWith('root-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json.mock.calls[0] as any)[0].data).toEqual({ teams });
  });

  it('403s a caller outside :id\'s scope', async () => {
    // An admin of a DIFFERENT org is refused.
    for (const user of [{ sub: 'b', organizationId: 'other', role: 'admin' }]) {
      const res = mockRes();
      await (listDeletedTeams as any)({ user, params: { id: 'root-1' } }, res);
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(mockListDeletedTeams).not.toHaveBeenCalled();
  });
});

describe('moveOrganization — sysadmin reparent', () => {
  const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  // `requireSystemAdmin` — platform-admin authority is a JWT claim.
  const moveReq = (parentOrgId: unknown, user: unknown = { sub: 'sys-1', isSuperAdmin: true }) =>
    ({ user, params: { id: 'team-1' }, body: { parentOrgId } });

  it('403s an org admin and 401s an anonymous caller, without moving anything', async () => {
    const orgAdmin = mockRes();
    await (moveOrganization as any)(moveReq(ROOT, { sub: 'a', organizationId: 'team-1', role: 'admin' }), orgAdmin);
    expect(orgAdmin.status).toHaveBeenCalledWith(403);

    const anon = mockRes();
    await (moveOrganization as any)(moveReq(ROOT, null), anon);
    expect(anon.status).toHaveBeenCalledWith(401);

    expect(mockMove).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

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
    // The non-sysadmin case still has to PASS `canAccessOrg`, so that caller is
    // a member of the org being read.
    const get = (isSuperAdmin: boolean) => (getOrganizationById as any)(
      { user: { sub: 'u', isSuperAdmin, organizationId: 'org-acme' }, params: { id: 'org-acme' }, query: {} }, mockRes(),
    );

    await get(true);
    expect(mockGetById).toHaveBeenLastCalledWith('org-acme', expect.objectContaining({ includeHierarchy: true }));
    await get(false);
    expect(mockGetById).toHaveBeenLastCalledWith('org-acme', expect.objectContaining({ includeHierarchy: false }));
  });

  it('403s a member of another org and 401s an anonymous caller', async () => {
    const outsider = mockRes();
    await (getOrganizationById as any)({ user: { sub: 'u', organizationId: 'org-other' }, params: { id: 'org-acme' }, query: {} }, outsider);
    expect(outsider.status).toHaveBeenCalledWith(403);

    const anon = mockRes();
    await (getOrganizationById as any)({ user: null, params: { id: 'org-acme' }, query: {} }, anon);
    expect(anon.status).toHaveBeenCalledWith(401);

    expect(mockGetById).not.toHaveBeenCalled();
  });
});
