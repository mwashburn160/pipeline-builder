// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/read-plugins.
 *
 * Extracts route handlers from the router and tests them directly
 * with mock req/res objects — no HTTP server needed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks — must be defined before imports

const mockFindPaginated = jest.fn();
const mockFind = jest.fn();
const mockFindById = jest.fn();

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: {
    findPaginated: mockFindPaginated,
    find: mockFind,
    findById: mockFindById,
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => {
  const mockIsSystemAdmin = jest.fn((_req?: any) => false);
  return apiCoreMock({
    getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
    isSystemAdmin: mockIsSystemAdmin,
    sendSuccess: jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
      const response: any = { success: true, statusCode };
      if (data !== undefined) response.data = data;
      if (message) response.message = message;
      res.status(statusCode).json(response);
    }),
    sendPaginatedNested: jest.fn((res: any, dataKey: string, data: any, opts: any) => {
      const pagination: any = { limit: opts.limit, offset: opts.offset, hasMore: opts.hasMore };
      if (opts.total !== undefined) pagination.total = opts.total;
      if (opts.nextCursor) pagination.nextCursor = opts.nextCursor;
      res.status(opts.statusCode ?? 200).json({ [dataKey]: data, pagination });
    }),
    sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
      res.status(400).json({ success: false, statusCode: 400, message: msg, code });
    }),
    sendInternalError: jest.fn((res: any, msg: string) => {
      res.status(500).json({ success: false, statusCode: 500, message: msg });
    }),
    sendEntityNotFound: jest.fn((res: any, entity: string) => {
      res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
    }),
    parsePaginationParams: jest.fn(() => ({
      limit: 25,
      offset: 0,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    })),
    incrementQuota: jest.fn(),
    validateQuery: jest.fn(() => ({ ok: true, value: {} })),
    PluginFilterSchema: {},
    normalizeArrayFields: jest.fn((p: any) => p),
  });
});

const mockGetContext = (req: any) => req.context;
const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  getContext: (req: any) => mockGetContext(req),
  withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
    const ctx = mockGetContext(req);
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
  incrementQuotaFromCtx: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  schema: { plugin: {} },
  CoreConstants: {
    CACHE_CONTROL_LIST: 'private, max-age=30, stale-while-revalidate=60',
    CACHE_CONTROL_DETAIL: 'private, max-age=60, stale-while-revalidate=120',
  },
  withTenantTx: jest.fn((fn: any) => fn({ execute: jest.fn().mockResolvedValue({ rows: [] }) })),
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  SQL: class {},
  sql: Object.assign((..._a: any[]) => ({}), { raw: (..._a: any[]) => ({}) }),
  or: jest.fn(),
  ilike: jest.fn(),
  eq: jest.fn(),
  and: jest.fn(),
}));

jest.unstable_mockModule('drizzle-orm/column', () => ({}));
jest.unstable_mockModule('drizzle-orm/pg-core', () => ({}));

const { isSystemAdmin, sendBadRequest, validateQuery } = await import('@pipeline-builder/api-core');
const { incrementQuotaFromCtx } = await import('@pipeline-builder/api-server');
const { createReadPluginRoutes } = await import('../src/routes/read-plugins.js');

// Helpers

const mockQuotaService = {
  increment: jest.fn().mockResolvedValue(undefined),
  check: jest.fn(),
  getUsage: jest.fn(),
} as any;

const router = createReadPluginRoutes(mockQuotaService);

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    headers: { authorization: 'Bearer tok' },
    context: {
      identity: { orgId: 'ORG-1' },
      log: jest.fn(),
    },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}

// Tests

describe('GET /plugins (list)', () => {
  const handler = getHandler('get', '/');

  beforeEach(() => jest.clearAllMocks());

  it('returns paginated plugins', async () => {
    const plugins = [
      { id: '1', name: 'lint', accessModifier: 'private' },
      { id: '2', name: 'build', accessModifier: 'private' },
    ];
    mockFindPaginated.mockResolvedValue({
      data: plugins,
      total: 2,
      limit: 25,
      offset: 0,
      hasMore: false,
    });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      plugins: expect.arrayContaining([
        expect.objectContaining({ id: '1' }),
        expect.objectContaining({ id: '2' }),
      ]),
      pagination: { limit: 25, offset: 0, hasMore: false, total: 2 },
    }));
  });

  it('does not inject accessModifier — service layer handles access scoping', async () => {
    // Access control is enforced by AccessControlQueryBuilder in pluginService,
    // not by the route. The route forwards the caller's filter unchanged.
    mockFindPaginated.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });
    (isSystemAdmin as jest.Mock).mockReturnValue(false);

    await handler(mockReq(), mockRes());

    expect(mockFindPaginated).toHaveBeenCalledWith(
      expect.not.objectContaining({ accessModifier: 'private' }),
      'org-1',
      expect.any(Object),
      // 4th arg: parentOrgId from the JWT (org → team inherited plugin visibility);
      // undefined here because the mock request is a flat (root) org.
      undefined,
    );
  });

  it('does not force accessModifier for system admins', async () => {
    mockFindPaginated.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });
    (isSystemAdmin as jest.Mock).mockReturnValue(true);

    await handler(mockReq(), mockRes());

    expect(mockFindPaginated).toHaveBeenCalledWith(
      expect.not.objectContaining({ accessModifier: 'private' }),
      'org-1',
      expect.any(Object),
      // 4th arg: parentOrgId from the JWT (org → team inherited plugin visibility);
      // undefined here because the mock request is a flat (root) org.
      undefined,
    );
  });

  it('returns 400 when orgId is missing', async () => {
    const req = mockReq({ context: { identity: { orgId: '' }, log: jest.fn() } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Organization ID is required' }));
  });

  it('returns 400 on invalid filter', async () => {
    (validateQuery as jest.Mock).mockReturnValueOnce({ ok: false, error: 'Invalid filter' });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Invalid filter');
  });

  it('returns 500 on service error', async () => {
    mockFindPaginated.mockRejectedValue(new Error('Connection reset'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('increments quota after successful response', async () => {
    mockFindPaginated.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });

    await handler(mockReq(), mockRes());

    expect(incrementQuotaFromCtx).toHaveBeenCalledWith(mockQuotaService, expect.objectContaining({ orgId: 'org-1' }), 'apiCalls');
  });
});

describe('GET /plugins/find', () => {
  const handler = getHandler('get', '/find');

  beforeEach(() => jest.clearAllMocks());

  it('returns the first matching plugin', async () => {
    const plugin = { id: '1', name: 'lint' };
    mockFind.mockResolvedValue([plugin]);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        plugin: expect.objectContaining({ id: '1' }),
      }),
    }));
  });

  it('returns 404 when no plugin found', async () => {
    mockFind.mockResolvedValue([]);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when orgId is missing', async () => {
    const req = mockReq({ context: { identity: { orgId: '' }, log: jest.fn() } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Organization ID is required' }));
  });
});

describe('GET /plugins/:id', () => {
  const handler = getHandler('get', '/:id');

  beforeEach(() => jest.clearAllMocks());

  it('returns a plugin by ID', async () => {
    const plugin = { id: 'uuid-1', name: 'lint', accessModifier: 'private' };
    mockFindById.mockResolvedValue(plugin);

    const req = mockReq({ params: { id: 'uuid-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        plugin: expect.objectContaining({ id: 'uuid-1' }),
      }),
    }));
  });

  it('returns 404 when plugin not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('passes parentOrgId to findById so a team can fetch a parent public plugin', async () => {
    mockFindById.mockResolvedValue({ id: 'uuid-1', name: 'shared', accessModifier: 'public' });

    const req = mockReq({ params: { id: 'uuid-1' }, user: { parentOrganizationId: 'root-1' } });
    await handler(req, mockRes());

    // 3rd arg: parentOrgId from the JWT (org → team inherited plugin visibility).
    expect(mockFindById).toHaveBeenCalledWith('uuid-1', 'org-1', 'root-1');
  });

  it('passes undefined parentOrgId for a flat (root) org', async () => {
    mockFindById.mockResolvedValue({ id: 'uuid-1', name: 'lint', accessModifier: 'private' });

    const req = mockReq({ params: { id: 'uuid-1' } }); // no user.parentOrganizationId
    await handler(req, mockRes());

    expect(mockFindById).toHaveBeenCalledWith('uuid-1', 'org-1', undefined);
  });

  it('allows non-admin to view public plugin (access control handled by service layer)', async () => {
    const plugin = { id: 'uuid-1', name: 'shared', accessModifier: 'public' };
    mockFindById.mockResolvedValue(plugin);
    (isSystemAdmin as jest.Mock).mockReturnValue(false);

    const req = mockReq({ params: { id: 'uuid-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows system admin to view public plugin', async () => {
    const plugin = { id: 'uuid-1', name: 'shared', accessModifier: 'public' };
    mockFindById.mockResolvedValue(plugin);
    (isSystemAdmin as jest.Mock).mockReturnValue(true);

    const req = mockReq({ params: { id: 'uuid-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Plugin ID is required.', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on service error', async () => {
    mockFindById.mockRejectedValue(new Error('Timeout'));

    const req = mockReq({ params: { id: 'uuid-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
