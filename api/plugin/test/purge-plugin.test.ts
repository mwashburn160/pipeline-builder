// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/purge-plugin.
 *
 * Extracts the POST /:id/purge handler from the router and tests it directly
 * with mock req/res objects — no HTTP server needed. The route delegates the
 * load-tombstone → visibility-gate → hard-delete → 404 skeleton to api-core's
 * shared `loadAndPurge`, and this suite runs the REAL helper (and the real
 * visibility ladder + response helpers it uses) rather than a stub, so the
 * route's contract is exercised end to end against `findDeletedById` +
 * `purgeById` on a mocked service.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Loaded by file path, NOT through the mocked '@pipeline-builder/api-core' entry,
// so the real implementation backs the mock's `loadAndPurge` export.
const { loadAndPurge } = await import('@pipeline-builder/api-core/lib/helpers/restore-helpers.js') as {
  loadAndPurge: (...args: any[]) => Promise<any>;
};

const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});
const sendSuccess = jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
  const response: any = { success: true, statusCode };
  if (data !== undefined) response.data = data;
  if (message) response.message = message;
  res.status(statusCode).json(response);
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitPluginAudit,
  loadAndPurge,
  sendSuccess,
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || '';
    if (options?.requireOrgId !== false && !orgId) {
      return res.status(400).json({ message: 'Organization ID is required' });
    }
    try {
      await handler({ req, res, ctx, orgId, userId });
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      return mockSendInternalErrorForRoute(res, msg);
    }
  },
}));

const mockFindDeletedById = jest.fn<AnyFn>();
const mockPurgeById = jest.fn<AnyFn>();

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: {
    findDeletedById: mockFindDeletedById,
    purgeById: mockPurgeById,
  },
}));

const mockEmitPluginAudit = jest.fn<AnyFn>();

const { createPurgePluginRoutes } = await import('../src/routes/purge-plugin.js');

const router = createPurgePluginRoutes({ increment: jest.fn<AnyFn>(), check: jest.fn<AnyFn>(), getUsage: jest.fn<AnyFn>() } as never);

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: { id: 'plugin-uuid-1' },
    query: {},
    body: {},
    headers: { authorization: 'Bearer tok' },
    user: { sub: 'user-1', permissions: [] },
    context: {
      identity: { orgId: 'ORG-1', userId: 'user-1' },
      log: jest.fn<AnyFn>(),
      requestId: 'req-1',
    },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  res.setHeader = jest.fn<AnyFn>();
  return res;
}

const existingPlugin = {
  id: 'plugin-uuid-1',
  name: 'test-plugin',
  version: '1.0.0',
  orgId: 'org-1',
  visibility: 'private',
  createdBy: 'user-1',
  isActive: false,
  isDefault: false,
};

describe('POST /plugins/:id/purge (purge)', () => {
  const handler = getHandler('post', '/:id/purge');

  beforeEach(() => { jest.clearAllMocks(); });

  it('hard-deletes the tombstone and returns 200', async () => {
    mockFindDeletedById.mockResolvedValue(existingPlugin);
    mockPurgeById.mockResolvedValue('plugin-uuid-1');

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindDeletedById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(mockPurgeById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, {}, 'Plugin permanently deleted.');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('emits an attributed plugin.purge audit event after a successful purge', async () => {
    mockFindDeletedById.mockResolvedValue(existingPlugin);
    mockPurgeById.mockResolvedValue('plugin-uuid-1');

    await handler(mockReq(), mockRes());

    expect(mockEmitPluginAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitPluginAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'plugin.purge',
        actorId: 'user-1',
        orgId: 'org-1',
        affectedOrgId: 'org-1',
        targetType: 'plugin',
        targetId: 'plugin-uuid-1',
        details: expect.objectContaining({
          pluginName: 'test-plugin',
          version: '1.0.0',
          visibility: 'private',
        }),
      }),
    );
  });

  it('returns 400 when ID is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindDeletedById).not.toHaveBeenCalled();
    expect(mockPurgeById).not.toHaveBeenCalled();
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when the tombstone does not exist (not currently soft-deleted)', async () => {
    mockFindDeletedById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockPurgeById).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when purgeById returns null (matched no rows in caller org)', async () => {
    mockFindDeletedById.mockResolvedValue(existingPlugin);
    mockPurgeById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockPurgeById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(sendSuccess).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it('returns 403 (publish gate) when a non-publisher purges a PUBLIC tombstone', async () => {
    mockFindDeletedById.mockResolvedValue({ ...existingPlugin, visibility: 'public' });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPurgeById).not.toHaveBeenCalled();
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it("returns 403 when a member purges another author's PRIVATE tombstone", async () => {
    mockFindDeletedById.mockResolvedValue({ ...existingPlugin, visibility: 'private', createdBy: 'someone-else' });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPurgeById).not.toHaveBeenCalled();
  });

  it('lets a plugins:publish holder purge a PUBLIC tombstone', async () => {
    mockFindDeletedById.mockResolvedValue({ ...existingPlugin, visibility: 'public' });
    mockPurgeById.mockResolvedValue('plugin-uuid-1');

    const res = mockRes();
    await handler(mockReq({ user: { sub: 'user-1', permissions: ['plugins:publish'] } }), res);

    expect(mockPurgeById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 500 on service error', async () => {
    mockFindDeletedById.mockRejectedValue(new Error('Database connection lost'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });
});
