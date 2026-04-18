// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/update-plugin.
 *
 * Extracts route handlers from the router and tests them directly
 * with mock req/res objects — no HTTP server needed.
 */

// Mocks — must be defined before imports

const mockIsSystemAdmin = jest.fn((_req?: any) => false);
const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

jest.mock('@mwashburn160/api-core', () => ({
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  ErrorCode: {
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  },
  isSystemAdmin: mockIsSystemAdmin,
  createLogger: jest.fn(() => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() })),
  errorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  requirePublicAccess: jest.fn((_req: any, _res: any, _resource: any) => true),
  resolveAccessModifier: jest.fn((_req: any, am?: string) => am || 'private'),
  pickDefined: jest.fn((obj: any) => {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) result[k] = v;
    }
    return result;
  }),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
    const response: any = { success: true, statusCode };
    if (data !== undefined) response.data = data;
    if (message) response.message = message;
    res.status(statusCode).json(response);
  }),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
    res.status(400).json({ success: false, statusCode: 400, message: msg, code });
  }),
  sendError: jest.fn((res: any, status: number, msg: string, code?: string) => {
    res.status(status).json({ success: false, statusCode: status, message: msg, code });
  }),
  sendInternalError: jest.fn((res: any, msg: string) => {
    res.status(500).json({ success: false, statusCode: 500, message: msg });
  }),
  validateBody: jest.fn((req: any) => {
    return { ok: true, value: req.body };
  }),
  PluginUpdateSchema: {},
  normalizeArrayFields: jest.fn((p: any) => p),
  sendEntityNotFound: jest.fn((res: any, entity: string) => {
    res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
  }),
}));

jest.mock('@mwashburn160/api-server', () => ({
  getContext: (req: any) => req.context,
  createProtectedRoute: () => [],
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

jest.mock('@mwashburn160/pipeline-core', () => ({
  PluginType: {},
  ComputeType: {},
  AccessModifier: {},
}));

const mockFindById = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../src/services/plugin-service', () => ({
  pluginService: {
    findById: mockFindById,
    update: mockUpdate,
  },
}));


// Imports (after mocks)

import { sendBadRequest, sendSuccess, requirePublicAccess, validateBody } from '@mwashburn160/api-core';
import { createUpdatePluginRoutes } from '../src/routes/update-plugin';

// Helpers

const router = createUpdatePluginRoutes();

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: { id: 'plugin-uuid-1' },
    query: {},
    body: {},
    headers: { authorization: 'Bearer tok' },
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

describe('PUT /plugins/:id (update)', () => {
  const handler = getHandler('put', '/:id');

  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on successful update', async () => {
    const updatedPlugin = { ...existingPlugin, name: 'updated-plugin' };
    mockFindById.mockResolvedValue(existingPlugin);
    mockUpdate.mockResolvedValue(updatedPlugin);

    const req = mockReq({ body: { name: 'updated-plugin' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(mockUpdate).toHaveBeenCalledWith(
      'plugin-uuid-1',
      expect.objectContaining({ name: 'updated-plugin' }),
      'org-1',
      'user-1',
    );
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, { plugin: updatedPlugin });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      statusCode: 200,
      data: expect.objectContaining({
        plugin: expect.objectContaining({ name: 'updated-plugin' }),
      }),
    }));
  });

  it('returns 400 when ID is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Plugin ID is required.', 'MISSING_REQUIRED_FIELD');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when body validation fails', async () => {
    (validateBody as jest.Mock).mockReturnValueOnce({ ok: false, error: 'Invalid field value' });

    const req = mockReq({ body: { name: '' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Invalid field value', 'VALIDATION_ERROR');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when plugin not found (findById returns null)', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 404,
      message: 'Plugin not found.',
    }));
  });

  it('returns 404 when update returns null', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockUpdate.mockResolvedValue(null);

    const req = mockReq({ body: { name: 'updated-plugin' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockUpdate).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 404,
      message: 'Plugin not found.',
    }));
  });

  it('returns 403 when requirePublicAccess returns false', async () => {
    mockFindById.mockResolvedValue({ ...existingPlugin, accessModifier: 'public' });
    (requirePublicAccess as jest.Mock).mockReturnValueOnce(false);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(requirePublicAccess).toHaveBeenCalledWith(req, res, expect.objectContaining({ accessModifier: 'public' }));
    expect(mockUpdate).not.toHaveBeenCalled();
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
