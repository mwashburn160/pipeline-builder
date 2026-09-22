// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/delete-plugin.
 *
 * Extracts route handlers from the router and tests them directly
 * with mock req/res objects — no HTTP server needed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks — must be defined before imports

const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

const mockRequireStepUp = jest.fn((_req: any, _res: any, next: () => void) => { next(); });
const mockDecrementQuota = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitPluginAudit,
  requireStepUp: mockRequireStepUp,
  decrementQuota: mockDecrementQuota,
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  requireVisibilityWriteAccess: jest.fn((_req: any, _res: any, _resource: any) => true),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
    const response: any = { success: true, statusCode };
    if (data !== undefined) response.data = data;
    if (message) response.message = message;
    res.status(statusCode).json(response);
  }),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
    res.status(400).json({ success: false, statusCode: 400, message: msg, code });
  }),
  sendEntityNotFound: jest.fn((res: any, entity: string) => {
    res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
  }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
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

const mockFindById = jest.fn<(...args: any[]) => any>();
const mockDeleteVersion = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: {
    findById: mockFindById,
    deleteVersion: mockDeleteVersion,
  },
}));

const mockEmitPluginAudit = jest.fn<AnyFn>();


// Imports (after mocks)

const { sendBadRequest, requireVisibilityWriteAccess, sendSuccess } = await import('@pipeline-builder/api-core');
const { createDeletePluginRoutes } = await import('../src/routes/delete-plugin.js');

// Helpers

const quotaService = { decrement: jest.fn<AnyFn>() } as any;
const router = createDeletePluginRoutes(quotaService);

function routeStack(method: string, path: string): any[] {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack;
}

function getHandler(method: string, path: string) {
  // The terminal withRoute handler is the LAST entry in the route stack: each
  // route now carries its permission gate (and, on writes, the `audited(...)`
  // declaration) ahead of it.
  const stack = routeStack(method, path);
  return stack[stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: { id: 'plugin-uuid-1' },
    query: {},
    body: {},
    headers: { authorization: 'Bearer tok' },
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
  return res;
}

const existingPlugin = {
  id: 'plugin-uuid-1',
  name: 'test-plugin',
  version: '1.0.0',
  orgId: 'org-1',
  visibility: 'private',
  isActive: true,
  isDefault: false,
};

// Tests

describe('DELETE /plugins/:id (delete)', () => {
  const handler = getHandler('delete', '/:id');

  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 200 on successful delete', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockDeleteVersion.mockResolvedValue({ deleted: existingPlugin, inUse: 0, listed: false, promoted: null });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(mockDeleteVersion).toHaveBeenCalledWith(existingPlugin, 'org-1', 'user-1', { force: false });
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, {}, 'Plugin deleted.');
    // No quota snapshot on the row → nothing to refund.
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      statusCode: 200,
      message: 'Plugin deleted.',
    }));
  });

  it('returns 400 when ID is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Plugin ID is required.', 'MISSING_REQUIRED_FIELD');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when plugin not found (findById returns null)', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(mockDeleteVersion).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 404,
      message: 'Plugin not found.',
    }));
  });

  it('returns 404 when delete returns null (public/system-org row matched no rows in caller org)', async () => {
    mockFindById.mockResolvedValue({ ...existingPlugin, quotaResetAt: new Date('2026-09-24T00:00:00Z') });
    mockDeleteVersion.mockResolvedValue({ deleted: null, inUse: 0, listed: false, promoted: null });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // A null delete means the row (e.g. a public/system-org plugin the read
    // surfaced) matched zero rows pinned to the caller's org: 404, no audit and
    // no refund for a deletion that never happened.
    expect(sendSuccess).not.toHaveBeenCalled();
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 when requireVisibilityWriteAccess returns false', async () => {
    mockFindById.mockResolvedValue({ ...existingPlugin, visibility: 'public' });
    (requireVisibilityWriteAccess as jest.Mock<AnyFn>).mockReturnValueOnce(false);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(requireVisibilityWriteAccess).toHaveBeenCalledWith(req, res, expect.objectContaining({ visibility: 'public' }), 'user-1', 'plugins:publish');
    expect(mockDeleteVersion).not.toHaveBeenCalled();
  });

  it('refunds the version\'s quota slot conditionally on its charge period', async () => {
    const quotaResetAt = new Date('2026-09-24T00:00:00.000Z');
    mockFindById.mockResolvedValue({ ...existingPlugin, quotaResetAt });
    mockDeleteVersion.mockResolvedValue({ deleted: existingPlugin, inUse: 0, listed: false, promoted: null });

    await handler(mockReq(), mockRes());

    expect(mockDecrementQuota).toHaveBeenCalledWith(
      quotaService, 'org-1', 'plugins', expect.any(String), expect.any(Function), 1, quotaResetAt.toISOString(),
    );
  });

  it('passes force through, reports the promoted default and audits the forced delete', async () => {
    const promoted = { id: 'plugin-uuid-0', version: '1.1.0' };
    mockFindById.mockResolvedValue({ ...existingPlugin, isDefault: true });
    mockDeleteVersion.mockResolvedValue({ deleted: existingPlugin, inUse: 2, listed: true, promoted });

    const res = mockRes();
    await handler(mockReq({ query: { force: 'true' } }), res);

    expect(mockDeleteVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'plugin-uuid-1' }), 'org-1', 'user-1', { force: true });
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, { promotedDefault: { id: 'plugin-uuid-0', version: '1.1.0' } }, 'Plugin deleted.');
    expect(mockEmitPluginAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.delete',
      details: expect.objectContaining({ force: true, inUsePipelines: 2, listed: true, promotedDefaultVersion: '1.1.0' }),
    }));
  });

  it('surfaces the service\'s in-use refusal instead of deleting', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockDeleteVersion.mockRejectedValue(new Error('This plugin version is used by 1 pipeline.'));

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(500); // the test's withRoute maps every throw to 500
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });
});

describe('DELETE /plugins/:id — step-up only for force', () => {
  // The route's own middleware between `audited(...)` and the handler.
  const stack = routeStack('delete', '/:id');
  const stepUpLayer = stack[stack.length - 2].handle;
  const handler = getHandler('delete', '/:id');

  beforeEach(() => { jest.clearAllMocks(); });

  it('does not demand a step-up for an ordinary delete', () => {
    const next = jest.fn<AnyFn>();
    stepUpLayer(mockReq(), mockRes(), next);
    expect(mockRequireStepUp).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('demands a step-up when force=true', () => {
    const next = jest.fn<AnyFn>();
    const req = mockReq({ query: { force: 'TRUE' } });
    stepUpLayer(req, mockRes(), next);
    expect(mockRequireStepUp).toHaveBeenCalledWith(req, expect.anything(), next);
  });

  it('returns 500 on service error', async () => {
    mockFindById.mockRejectedValue(new Error('Database connection lost'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 500,
      message: 'Database connection lost',
    }));
  });
});
