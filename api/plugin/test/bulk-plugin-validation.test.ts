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

const mockUpdateMany = jest.fn();
const mockBulkDelete = jest.fn();

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: {
    updateMany: mockUpdateMany,
    bulkDelete: mockBulkDelete,
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  // Admins/owners keep 'public'; everyone else is coerced to 'private'.
  resolveAccessModifier: (req: any, requested: string) =>
    (requested === 'public' && (req?.user?.role === 'admin' || req?.user?.role === 'owner')) ? 'public' : 'private',
  isSystemAdmin: (req: any) => req?.user?.isSuperAdmin === true,
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
    mockUpdateMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    const handler = getUpdateHandler();
    const { res } = makeRes();
    await handler({
      body: {
        ids: ['p1', 'p2'],
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
        ids: ['p1'],
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
        ids: ['p1'],
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

describe('POST /plugins/bulk/delete — public-plugin access parity', () => {
  beforeEach(() => { mockBulkDelete.mockReset(); (mockBulkDelete as any).mockResolvedValue([]); });

  it('restricts a non-sysadmin to PRIVATE plugins (restrictToPrivate=true)', async () => {
    const { res } = makeRes();
    await getDeleteHandler()({ body: { ids: ['p1'] }, user: { isSuperAdmin: false } }, res);
    expect(mockBulkDelete).toHaveBeenCalledWith(['p1'], 'org-1', 'u-1', true);
  });

  it('lets a sysadmin delete public plugins too (restrictToPrivate=false)', async () => {
    const { res } = makeRes();
    await getDeleteHandler()({ body: { ids: ['p1'] }, user: { isSuperAdmin: true } }, res);
    expect(mockBulkDelete).toHaveBeenCalledWith(['p1'], 'org-1', 'u-1', false);
  });
});
