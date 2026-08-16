// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/restore-plugin.
 *
 * Extracts the POST /:id/restore handler from the router and tests it directly
 * with mock req/res objects — no HTTP server needed. Mirrors the sibling
 * delete-plugin-routes.test.ts mocking approach.
 *
 * The route delegates its load → publish-gate → restore → 404 skeleton to
 * api-core's shared `loadAndRestore`. Because the whole api-core package is
 * wholesale-mocked here, this suite installs a FAITHFUL re-implementation of
 * `loadAndRestore` in the mock that delegates to the passed-in service singleton
 * + the same `requirePublicAccess` / `sendEntityNotFound` / `sendBadRequest`
 * spies the real helper uses, so every branch is exercised end-to-end.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks — must be defined before imports

const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

// Shared spies used both as api-core exports AND inside the faithful
// loadAndRestore re-implementation below.
const sendBadRequest = jest.fn((res: any, msg: string, code?: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg, code });
});
const sendEntityNotFound = jest.fn((res: any, entity: string) => {
  res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
});
const requirePublicAccess = jest.fn((_req: any, _res: any, _resource: any, _perm?: string) => true);
const sendSuccess = jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
  const response: any = { success: true, statusCode };
  if (data !== undefined) response.data = data;
  if (message) response.message = message;
  res.status(statusCode).json(response);
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  requirePublicAccess,
  sendSuccess,
  sendBadRequest,
  sendEntityNotFound,
  loadAndRestore: jest.fn(async (
    req: any,
    res: any,
    orgId: string,
    userId: string,
    service: any,
    label: string,
    publishPermission: string,
  ) => {
    const id = req.params?.id;
    if (!id) {
      sendBadRequest(res, `${label} ID is required.`, 'MISSING_REQUIRED_FIELD');
      return null;
    }
    const existing = await service.findDeletedById(id, orgId);
    if (!existing) {
      sendEntityNotFound(res, label);
      return null;
    }
    if (!requirePublicAccess(req, res, existing, publishPermission)) return null;
    const restored = await service.restore(id, orgId, userId || 'system');
    if (!restored) {
      sendEntityNotFound(res, label);
      return null;
    }
    return { existing, restored };
  }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || '';
    const requireOrgId = options?.requireOrgId !== false;
    if (requireOrgId && !orgId) {
      return mockSendBadRequestForRoute(res, 'Organization ID is required');
    }
    try {
      await handler({ req, res, ctx, orgId, userId });
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      return mockSendInternalErrorForRoute(res, msg);
    }
  },
}));

const mockFindDeletedById = jest.fn();
const mockRestore = jest.fn();

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: {
    findDeletedById: mockFindDeletedById,
    restore: mockRestore,
  },
}));

const mockEmitPluginAudit = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPluginAudit: mockEmitPluginAudit,
  getAuditClient: () => ({ record: jest.fn() }),
}));

// shapePlugin adds a computed `uri`; identity-ish stub suffices here.
jest.unstable_mockModule('../src/helpers/plugin-helpers.js', () => ({
  shapePlugin: (p: any) => ({ ...p, uri: `uri:${p.id}` }),
}));

// Imports (after mocks)

const { createRestorePluginRoutes } = await import('../src/routes/restore-plugin.js');

// Helpers

const router = createRestorePluginRoutes();

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
    user: { sub: 'user-1' },
    context: {
      identity: { orgId: 'ORG-1', userId: 'user-1' },
      log: jest.fn(),
      requestId: 'req-1',
    },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const existingPlugin = {
  id: 'plugin-uuid-1',
  name: 'test-plugin',
  version: '1.0.0',
  orgId: 'org-1',
  accessModifier: 'private',
  isActive: true,
  isDefault: false,
};

// Tests

describe('POST /plugins/:id/restore (restore)', () => {
  const handler = getHandler('post', '/:id/restore');

  beforeEach(() => jest.clearAllMocks());

  it('restores the tombstone and returns 200 with the shaped plugin', async () => {
    mockFindDeletedById.mockResolvedValue(existingPlugin);
    mockRestore.mockResolvedValue(existingPlugin);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindDeletedById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(mockRestore).toHaveBeenCalledWith('plugin-uuid-1', 'org-1', 'user-1');
    expect(sendSuccess).toHaveBeenCalledWith(
      res,
      200,
      { plugin: expect.objectContaining({ id: 'plugin-uuid-1', uri: 'uri:plugin-uuid-1' }) },
      'Plugin restored.',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        statusCode: 200,
        message: 'Plugin restored.',
      }),
    );
  });

  it('emits an attributed plugin.restore audit event after a successful restore', async () => {
    mockFindDeletedById.mockResolvedValue(existingPlugin);
    mockRestore.mockResolvedValue(existingPlugin);

    await handler(mockReq(), mockRes());

    expect(mockEmitPluginAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitPluginAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'plugin.restore',
        actorId: 'user-1',
        orgId: 'org-1',
        affectedOrgId: 'org-1', // existing.orgId
        targetType: 'plugin',
        targetId: 'plugin-uuid-1',
        details: expect.objectContaining({
          pluginName: 'test-plugin',
          version: '1.0.0',
          accessModifier: 'private',
        }),
      }),
    );
  });

  it('attributes affectedOrgId to the tombstone org (not the caller org)', async () => {
    mockFindDeletedById.mockResolvedValue({ ...existingPlugin, orgId: 'target-org' });
    mockRestore.mockResolvedValue({ ...existingPlugin, orgId: 'target-org' });

    await handler(mockReq(), mockRes());

    expect(mockEmitPluginAudit).toHaveBeenCalledWith(
      expect.objectContaining({ affectedOrgId: 'target-org' }),
    );
  });

  it('returns 400 when ID is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Plugin ID is required.', 'MISSING_REQUIRED_FIELD');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindDeletedById).not.toHaveBeenCalled();
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when the tombstone does not exist (findDeletedById returns null)', async () => {
    mockFindDeletedById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindDeletedById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(mockRestore).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 404,
      message: 'Plugin not found.',
    }));
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when restore returns null (matched no rows in caller org)', async () => {
    mockFindDeletedById.mockResolvedValue(existingPlugin);
    mockRestore.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockRestore).toHaveBeenCalledWith('plugin-uuid-1', 'org-1', 'user-1');
    expect(sendSuccess).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it('returns 403 (publish gate) when a non-publisher restores a PUBLIC tombstone', async () => {
    mockFindDeletedById.mockResolvedValue({ ...existingPlugin, accessModifier: 'public' });
    requirePublicAccess.mockReturnValueOnce(false);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(requirePublicAccess).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ accessModifier: 'public' }),
      'plugins:publish',
    );
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it('returns 500 on service error', async () => {
    mockFindDeletedById.mockRejectedValue(new Error('Database connection lost'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 500,
      message: 'Database connection lost',
    }));
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });
});
