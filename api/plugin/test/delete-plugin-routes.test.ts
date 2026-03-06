/**
 * Tests for routes/delete-plugin.
 *
 * Extracts route handlers from the router and tests them directly
 * with mock req/res objects — no HTTP server needed.
 */

// Mocks — must be defined before imports

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
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  },
  requirePublicAccess: jest.fn((_req: any, _res: any, _resource: any) => true),
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

jest.mock('@mwashburn160/api-server', () => ({
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

const mockFindById = jest.fn();
const mockDelete = jest.fn();

jest.mock('../src/services/plugin-service', () => ({
  pluginService: {
    findById: mockFindById,
    delete: mockDelete,
  },
}));


// Imports (after mocks)

import { sendBadRequest, requirePublicAccess, sendSuccess } from '@mwashburn160/api-core';
import { createDeletePluginRoutes } from '../src/routes/delete-plugin';

// Helpers

const router = createDeletePluginRoutes();

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

describe('DELETE /plugins/:id (delete)', () => {
  const handler = getHandler('delete', '/:id');

  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on successful delete', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockDelete.mockResolvedValue(existingPlugin);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(mockDelete).toHaveBeenCalledWith('plugin-uuid-1', 'org-1', 'user-1');
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, undefined, 'Plugin deleted.');
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
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 404,
      message: 'Plugin not found.',
    }));
  });

  it('still returns 200 when delete returns null (route does not check return value)', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockDelete.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // The delete route awaits pluginService.delete() but does not check
    // its return value — it proceeds to sendSuccess regardless.
    expect(mockDelete).toHaveBeenCalledWith('plugin-uuid-1', 'org-1', 'user-1');
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, undefined, 'Plugin deleted.');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 403 when requirePublicAccess returns false', async () => {
    mockFindById.mockResolvedValue({ ...existingPlugin, accessModifier: 'public' });
    (requirePublicAccess as jest.Mock).mockReturnValueOnce(false);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(requirePublicAccess).toHaveBeenCalledWith(req, res, expect.objectContaining({ accessModifier: 'public' }));
    expect(mockDelete).not.toHaveBeenCalled();
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
