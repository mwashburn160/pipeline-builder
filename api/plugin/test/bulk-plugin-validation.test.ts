// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the BulkPluginUpdateDataSchema strict whitelist on
 * PUT /plugins/bulk/update. Without this validation a caller could write
 * internal fields (orgId, deletedAt, secrets) or rename (name, version)
 * every plugin in their org with one call.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Bulk routes accept FULL UUIDs only (a partial id prefix-matches in the CRUD layer).
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';

const mockUpdateMany = jest.fn<AnyFn>();
const mockFindByIds = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue([]);
const mockBulkDelete = jest.fn<AnyFn>();
const mockDeleteBlockers = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue({ frozen: false, listed: false, inUse: 0 });
const mockClearQuotaSnapshot = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue(undefined);
const mockPromoteNextDefault = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue(null);
const mockDecrementQuota = jest.fn<AnyFn>();
const mockVersionImmutability = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue(null);

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: {
    updateMany: mockUpdateMany,
    bulkDelete: mockBulkDelete,
    findByIds: mockFindByIds,
    deleteBlockers: mockDeleteBlockers,
    clearQuotaSnapshot: mockClearQuotaSnapshot,
    promoteNextDefault: mockPromoteNextDefault,
    versionImmutability: mockVersionImmutability,
  },
}));

// Fail-closed compliance re-check shared with single-row update.
const mockValidatePlugin = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue({ blocked: false, violations: [] });

const mockEmitPluginAudit = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitPluginAudit,
  decrementQuota: mockDecrementQuota,
  createComplianceClient: () => ({ validatePlugin: mockValidatePlugin }),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  // Admins/owners keep 'public'; everyone else is coerced to 'private'.
  resolveVisibility: (req: any, requested: string) =>
    (requested === 'public' && (req?.user?.role === 'admin' || req?.user?.role === 'owner')) ? 'public' : 'private',
  isSystemAdmin: (req: any) => req?.user?.isSuperAdmin === true,
  // Bulk delete now applies the full visibility ladder, so it needs the
  // caller's publish permission (not just sysadmin-or-not).
  userHasPermission: (req: any, perm: string) => req?.user?.permissions?.includes(perm) === true,
  // The real ladder predicate, keyed off the mocked permission helpers above.
  checkVisibilityWriteAccess: (req: any, row: any, userId: string, perm: string) => {
    if (req?.user?.isSuperAdmin === true) return 'ok';
    if (row.visibility === 'public' && !(req?.user?.permissions ?? []).includes(perm)) return 'needs-publish';
    if (row.visibility === 'private' && (!userId || row.createdBy !== userId)) return 'not-author';
    return 'ok';
  },
  sendError: jest.fn((res: any, status: number, msg: string, _code?: string, details?: any) => res.status(status).json({ message: msg, ...details })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), requestId: 'r-1' };
    // `userId` mirrors the real wrapper, which takes it from `getIdentity` —
    // i.e. the JWT `sub`. Hardcoding it let a fixture set `user.sub` and still
    // get a different route-context userId, a request no real caller produces.
    await handler({ req, res, ctx, orgId: 'org-1', userId: req.user?.sub ?? 'u-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: { MAX_BULK_ITEMS: 100 },
}));

const { createBulkPluginRoutes } = await import('../src/routes/bulk-plugin.js');

/** The quota service the routes are constructed with — refunds must go through it. */
const quotaService = { increment: jest.fn<AnyFn>(), check: jest.fn<AnyFn>(), getUsage: jest.fn<AnyFn>() } as never;

function getUpdateHandler() {
  const router = createBulkPluginRoutes(quotaService);
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/bulk/update' && l.route?.methods?.put,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  return { res: { status, json }, status, json };
}

describe('PUT /plugins/bulk/update — strict update-data whitelist', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('accepts the whitelisted fields', async () => {
    mockUpdateMany.mockResolvedValue([{ id: P1 }, { id: P2 }]);
    const handler = getUpdateHandler();
    const { res } = makeRes();
    await handler({
      body: {
        ids: [P1, P2],
        data: { isActive: false, category: 'test' },
      },
    }, res);
    expect(mockUpdateMany).toHaveBeenCalled();
  });

  it('rejects unknown fields (strict mode)', async () => {
    const handler = getUpdateHandler();
    const { res, status } = makeRes();
    await handler({
      body: {
        ids: [P1],
        data: { orgId: 'OTHER-org' }, // tenant boundary — must be rejected
      },
    }, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects internal fields like deletedAt and immutable fields like name', async () => {
    const handler = getUpdateHandler();
    const { res, status } = makeRes();
    await handler({
      body: {
        ids: [P1],
        data: { deletedAt: null, name: 'renamed' },
      },
    }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects empty ids array', async () => {
    const handler = getUpdateHandler();
    const { res, status } = makeRes();
    await handler({
      body: { ids: [], data: { isActive: true } },
    }, res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('rejects oversize ids array (> MAX_BULK_ITEMS)', async () => {
    const handler = getUpdateHandler();
    const { res, status } = makeRes();
    await handler({
      body: { ids: new Array(150).fill('p'), data: { isActive: true } },
    }, res);
    expect(status).toHaveBeenCalledWith(400);
  });
});

function getDeleteHandler() {
  const router = createBulkPluginRoutes(quotaService);
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/bulk/delete' && l.route?.methods?.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe('POST /plugins/bulk/delete — visibility ladder parity', () => {
  beforeEach(() => { mockBulkDelete.mockReset(); (mockBulkDelete as any).mockResolvedValue([]); });

  // The route used to pass a `restrictToPrivate` boolean, which narrowed the
  // delete to `visibility='private'` — the OLD two-state model. Since plugins
  // default to `org`, that silently skipped the normal case. It now passes the
  // caller's authority and the service applies the three rungs.
  it('passes the caller authority for a plain member (no publish permission)', async () => {
    const { res } = makeRes();
    await getDeleteHandler()({ body: { ids: [P1] }, user: { isSuperAdmin: false, permissions: [] } }, res);
    expect(mockBulkDelete).toHaveBeenCalledWith([P1], 'org-1', 'u-1', {
      isSystemAdmin: false,
      canPublish: false,
    });
  });

  it('reports canPublish for a caller holding plugins:publish', async () => {
    const { res } = makeRes();
    await getDeleteHandler()({ body: { ids: [P1] }, user: { isSuperAdmin: false, permissions: ['plugins:publish'] } }, res);
    expect(mockBulkDelete).toHaveBeenCalledWith([P1], 'org-1', 'u-1', {
      isSystemAdmin: false,
      canPublish: true,
    });
  });

  it('lets a sysadmin delete anything', async () => {
    const { res } = makeRes();
    await getDeleteHandler()({ body: { ids: [P1] }, user: { isSuperAdmin: true } }, res);
    expect(mockBulkDelete).toHaveBeenCalledWith([P1], 'org-1', 'u-1', {
      isSystemAdmin: true,
      canPublish: false,
    });
  });
});

describe('POST /plugins/bulk/delete — delete safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByIds.mockResolvedValue([]);
    mockDeleteBlockers.mockResolvedValue({ frozen: false, listed: false, inUse: 0 });
  });

  it('skips frozen, listed and in-use versions (no force in bulk) and deletes the rest', async () => {
    mockFindByIds.mockResolvedValue([
      { id: P1, orgId: 'org-1' }, { id: P2, orgId: 'org-1' }, { id: P3, orgId: 'org-1' },
    ]);
    mockDeleteBlockers
      .mockResolvedValueOnce({ frozen: true, listed: false, inUse: 0 })
      .mockResolvedValueOnce({ frozen: false, listed: true, inUse: 0 })
      .mockResolvedValueOnce({ frozen: false, listed: false, inUse: 0 });
    mockBulkDelete.mockResolvedValue([{ id: P3, orgId: 'org-1' }]);
    const { res, json } = makeRes();

    await getDeleteHandler()({ body: { ids: [P1, P2, P3] }, user: { isSuperAdmin: false } }, res);

    expect(mockBulkDelete).toHaveBeenCalledWith([P3], 'org-1', 'u-1', expect.any(Object));
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: { deleted: 1, ids: [P3], skipped: [{ id: P1, reason: 'frozen' }, { id: P2, reason: 'listed' }] },
    }));
  });

  it('reports an in-use version as skipped and never calls bulkDelete when nothing is left', async () => {
    mockFindByIds.mockResolvedValue([{ id: P1, orgId: 'org-1' }]);
    mockDeleteBlockers.mockResolvedValueOnce({ frozen: false, listed: false, inUse: 3 });
    const { res, json } = makeRes();

    await getDeleteHandler()({ body: { ids: [P1] }, user: { isSuperAdmin: false } }, res);

    expect(mockBulkDelete).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ data: { deleted: 0, ids: [], skipped: [{ id: P1, reason: 'in_use' }] } }));
  });

  it("does not judge another org's row (bulkDelete pins the org and skips it)", async () => {
    mockFindByIds.mockResolvedValue([{ id: P1, orgId: 'system' }]);
    mockBulkDelete.mockResolvedValue([]);
    const { res } = makeRes();

    await getDeleteHandler()({ body: { ids: [P1] }, user: { isSuperAdmin: false } }, res);

    expect(mockDeleteBlockers).not.toHaveBeenCalled();
    expect(mockBulkDelete).toHaveBeenCalledWith([P1], 'org-1', 'u-1', expect.any(Object));
  });

  it('refunds each deleted slot period-conditionally and promotes a new default for a deleted default', async () => {
    const quotaResetAt = new Date('2026-09-24T00:00:00.000Z');
    mockBulkDelete.mockResolvedValue([
      { id: P1, orgId: 'org-1', name: 'a', version: '1.0.0', isDefault: true, quotaResetAt },
      { id: P2, orgId: 'org-1', name: 'b', version: '1.0.0', isDefault: false, quotaResetAt: null },
    ]);
    const { res } = makeRes();

    await getDeleteHandler()({ body: { ids: [P1, P2] }, user: { isSuperAdmin: false } }, res);

    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockDecrementQuota).toHaveBeenCalledWith(
      quotaService, 'org-1', 'plugins', expect.any(String), expect.any(Function), 1, quotaResetAt.toISOString(),
    );
    expect(mockClearQuotaSnapshot).toHaveBeenCalledWith(P1);
    expect(mockPromoteNextDefault).toHaveBeenCalledTimes(1);
    expect(mockPromoteNextDefault).toHaveBeenCalledWith('org-1', expect.objectContaining({ id: P1 }), 'u-1');
  });
});

// Attributed audit emissions — ONE event per bulk op, only when rows landed.
describe('bulk plugin audit emissions', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('emits ONE plugin.bulk.delete with count + actually-deleted ids', async () => {
    mockBulkDelete.mockResolvedValue([{ id: P1 }, { id: P3 }]);
    const { res } = makeRes();
    await getDeleteHandler()({ body: { ids: [P1, P2, P3] }, user: { isSuperAdmin: true, sub: 'admin-1' } }, res);

    expect(mockEmitPluginAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitPluginAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'plugin.bulk.delete',
        actorId: 'admin-1',
        orgId: 'org-1',
        targetType: 'plugin',
        details: expect.objectContaining({ count: 2, ids: [P1, P3] }),
      }),
    );
  });

  it('does NOT emit plugin.bulk.delete when nothing was deleted', async () => {
    mockBulkDelete.mockResolvedValue([]);
    const { res } = makeRes();
    await getDeleteHandler()({ body: { ids: [P1] }, user: { isSuperAdmin: false } }, res);
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it('emits ONE plugin.bulk.update with count + actually-updated ids', async () => {
    mockUpdateMany.mockResolvedValue([{ id: P1 }, { id: P2 }]);
    const { res } = makeRes();
    await getUpdateHandler()({ body: { ids: [P1, P2], data: { isActive: false } }, user: { sub: 'u-9' } }, res);

    expect(mockEmitPluginAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitPluginAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'plugin.bulk.update',
        actorId: 'u-9',
        orgId: 'org-1',
        targetType: 'plugin',
        details: expect.objectContaining({ count: 2, ids: [P1, P2] }),
      }),
    );
  });

  it('does NOT emit plugin.bulk.update when nothing changed', async () => {
    mockUpdateMany.mockResolvedValue([]);
    const { res } = makeRes();
    await getUpdateHandler()({ body: { ids: [P1], data: { isActive: false } } }, res);
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });
});

// The three bulk-update gaps: prefix/empty ids, public rows without publish,
// and isDefault=true fan-out.
describe('PUT /plugins/bulk/update — exact ids, visibility ladder, singular default', () => {
  beforeEach(() => { jest.clearAllMocks(); mockFindByIds.mockResolvedValue([]); mockUpdateMany.mockResolvedValue([]); });

  it.each([
    ['an empty-string id (would LIKE-match every plugin)', ['']],
    ['a partial/prefix id', ['1111']],
    ['a mix of a valid UUID and a prefix', [P1, 'a']],
  ])('rejects %s with 400 before touching the DB', async (_label, ids) => {
    const { res, status } = makeRes();
    await getUpdateHandler()({ body: { ids, data: { isActive: false } }, user: { permissions: [] } }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockFindByIds).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID id on bulk DELETE too', async () => {
    const { res, status } = makeRes();
    await getDeleteHandler()({ body: { ids: [''] }, user: { permissions: [] } }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockBulkDelete).not.toHaveBeenCalled();
  });

  it('403s (listing the ids) when a member without plugins:publish targets a PUBLIC plugin', async () => {
    mockFindByIds.mockResolvedValue([
      { id: P1, visibility: 'org', createdBy: 'x' },
      { id: P2, visibility: 'public', createdBy: 'u-1' },
    ]);
    const { res, status, json } = makeRes();
    await getUpdateHandler()({ body: { ids: [P1, P2], data: { isActive: false } }, user: { permissions: [] } }, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ids: [P2] }));
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("403s on another author's PRIVATE plugin", async () => {
    mockFindByIds.mockResolvedValue([{ id: P1, visibility: 'private', createdBy: 'someone-else' }]);
    const { res, status } = makeRes();
    await getUpdateHandler()({ body: { ids: [P1], data: { isActive: false } }, user: { permissions: [] } }, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('lets a plugins:publish holder update a PUBLIC plugin, with exact ids', async () => {
    mockFindByIds.mockResolvedValue([{ id: P2, visibility: 'public', createdBy: 'x' }]);
    const { res } = makeRes();
    await getUpdateHandler()({ body: { ids: [P2], data: { isActive: false } }, user: { permissions: ['plugins:publish'] } }, res);
    expect(mockFindByIds).toHaveBeenCalledWith([P2], 'org-1');
    expect(mockUpdateMany).toHaveBeenCalledWith({ id: [P2] }, expect.anything(), 'org-1', 'u-1');
  });

  it('rejects isDefault=true in bulk (would create multiple defaults); allows isDefault=false', async () => {
    const { res, status } = makeRes();
    await getUpdateHandler()({ body: { ids: [P1], data: { isDefault: true } }, user: { permissions: [] } }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();

    const second = makeRes();
    await getUpdateHandler()({ body: { ids: [P1], data: { isDefault: false } }, user: { permissions: [] } }, second.res);
    expect(mockUpdateMany).toHaveBeenCalled();
  });
});

// Bulk update used to skip the compliance re-check single-row update runs, so a
// bulk visibility flip could turn a compliant plugin non-compliant.
describe('PUT /plugins/bulk/update — compliance re-check parity with single update', () => {
  const rows = [
    { id: P1, name: 'a', version: '1.0.0', visibility: 'org', createdBy: 'u-1', env: {}, buildArgs: {} },
    { id: P2, name: 'b', version: '2.0.0', visibility: 'org', createdBy: 'u-1', env: {}, buildArgs: {} },
  ];
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByIds.mockResolvedValue(rows);
    mockUpdateMany.mockResolvedValue(rows);
    mockValidatePlugin.mockResolvedValue({ blocked: false, violations: [] });
  });

  it('re-validates every matched row with the post-update visibility (even for a sysadmin)', async () => {
    const { res } = makeRes();
    await getUpdateHandler()({ body: { ids: [P1, P2], data: { visibility: 'private' } }, user: { isSuperAdmin: true } }, res);
    expect(mockValidatePlugin).toHaveBeenCalledTimes(2);
    // The stored image facts ride along; `packages` (post-build only) is deferred.
    expect(mockValidatePlugin).toHaveBeenCalledWith('org-1', expect.objectContaining({ name: 'a', visibility: 'private', signed: false }),
      expect.any(String), P1, 'a', 'update', ['packages']);
    expect(mockUpdateMany).toHaveBeenCalled();
  });

  it('403s the whole batch (listing blocked ids) when compliance blocks a row', async () => {
    mockValidatePlugin
      .mockResolvedValueOnce({ blocked: false, violations: [] })
      .mockResolvedValueOnce({ blocked: true, violations: [{ rule: 'no-private' }] });
    const { res, status, json } = makeRes();
    await getUpdateHandler()({ body: { ids: [P1, P2], data: { visibility: 'private' } }, user: { isSuperAdmin: true } }, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ blocked: [{ id: P2, violations: [{ rule: 'no-private' }] }] }));
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('503s (fail-closed) when the compliance service is unreachable', async () => {
    mockValidatePlugin.mockRejectedValue(new Error('ECONNREFUSED'));
    const { res, status } = makeRes();
    await getUpdateHandler()({ body: { ids: [P1], data: { visibility: 'private' } }, user: { permissions: [] } }, res);
    expect(status).toHaveBeenCalledWith(503);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('skips the round-trip for a catalog-metadata-only edit', async () => {
    const { res } = makeRes();
    await getUpdateHandler()({ body: { ids: [P1], data: { description: 'x', isActive: false } }, user: { isSuperAdmin: true } }, res);
    expect(mockValidatePlugin).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalled();
  });
});

describe('PUT /plugins/bulk/update — frozen / listed versions (same rule as single update)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVersionImmutability.mockResolvedValue(null);
  });

  const admin = { sub: 'u-1', isSuperAdmin: true };

  it('skips a frozen and a listed version with a per-item 409 when catalog fields change', async () => {
    mockFindByIds.mockResolvedValue([
      { id: P1, orgId: 'org-1', visibility: 'org' },
      { id: P2, orgId: 'org-1', visibility: 'org' },
      { id: P3, orgId: 'org-1', visibility: 'org' },
    ]);
    mockVersionImmutability.mockImplementation(async (row: any) =>
      row.id === P1 ? 'frozen' : row.id === P2 ? 'listed' : null);
    mockUpdateMany.mockResolvedValue([{ id: P3 }]);
    const { res, json } = makeRes();
    await getUpdateHandler()({ user: admin, body: { ids: [P1, P2, P3], data: { keywords: ['x'], category: 'lint' } } }, res);

    expect(mockUpdateMany).toHaveBeenCalledWith({ id: [P3] }, expect.anything(), 'org-1', 'u-1');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        updated: 1,
        skipped: [
          { id: P1, reason: 'frozen', statusCode: 409, code: expect.any(String) },
          { id: P2, reason: 'listed', statusCode: 409, code: expect.any(String) },
        ],
      },
    }));
  });

  it('updates nothing when every version is locked', async () => {
    mockFindByIds.mockResolvedValue([{ id: P1, orgId: 'org-1', visibility: 'org' }]);
    mockVersionImmutability.mockResolvedValue('listed');
    const { res, json } = makeRes();
    await getUpdateHandler()({ user: admin, body: { ids: [P1], data: { description: 'new' } } }, res);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ data: { updated: 0, skipped: [expect.objectContaining({ id: P1, reason: 'listed' })] } }));
  });

  it('does not consult immutability for operational-only fields (isActive)', async () => {
    mockUpdateMany.mockResolvedValue([{ id: P1 }]);
    const { res } = makeRes();
    await getUpdateHandler()({ user: admin, body: { ids: [P1], data: { isActive: false } } }, res);
    expect(mockVersionImmutability).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalledWith({ id: [P1] }, expect.anything(), 'org-1', 'u-1');
  });

  it('ignores rows owned by another org (updateMany never touches them)', async () => {
    mockFindByIds.mockResolvedValue([{ id: P1, orgId: 'system', visibility: 'public' }]);
    mockUpdateMany.mockResolvedValue([]);
    const { res } = makeRes();
    await getUpdateHandler()({ user: admin, body: { ids: [P1], data: { category: 'lint' } } }, res);
    expect(mockVersionImmutability).not.toHaveBeenCalled();
  });
});
