// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the BulkPluginUpdateDataSchema strict whitelist on
 * PUT /plugins/bulk/update. Without this validation a caller could write
 * internal fields (orgId, deletedAt, secrets) or rename (name, version)
 * every plugin in their org with one call.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Bulk routes accept FULL UUIDs only (a partial id prefix-matches in the CRUD layer).
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';

const mockUpdateMany = jest.fn();
const mockFindByIds = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue([]);
const mockBulkDelete = jest.fn();

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: {
    updateMany: mockUpdateMany,
    bulkDelete: mockBulkDelete,
    findByIds: mockFindByIds,
  },
}));

const mockEmitPluginAudit = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPluginAudit: mockEmitPluginAudit,
  getAuditClient: () => ({ record: jest.fn() }),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
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

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), requestId: 'r-1' };
    await handler({ req, res, ctx, orgId: 'org-1', userId: 'u-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: { MAX_BULK_ITEMS: 100 },
}));

const { createBulkPluginRoutes } = await import('../src/routes/bulk-plugin.js');

function getUpdateHandler() {
  const router = createBulkPluginRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/bulk/update' && l.route?.methods?.put,
  );
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json }, status, json };
}

describe('PUT /plugins/bulk/update — strict update-data whitelist', () => {
  beforeEach(() => jest.clearAllMocks());

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
  const router = createBulkPluginRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/bulk/delete' && l.route?.methods?.post,
  );
  return layer.route.stack[0].handle;
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

// Attributed audit emissions — ONE event per bulk op, only when rows landed.
describe('bulk plugin audit emissions', () => {
  beforeEach(() => jest.clearAllMocks());

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
