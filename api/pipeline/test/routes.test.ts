/**
 * Tests for routes/read-pipelines.
 *
 * Extracts route handlers from the router and tests them directly
 * with mock req/res objects — no HTTP server needed.
 */

// Mocks — must be defined before imports

const mockFindPaginated = jest.fn();
const mockFind = jest.fn();
const mockFindById = jest.fn();

jest.mock('../src/services/pipeline-service', () => ({
  pipelineService: {
    findPaginated: mockFindPaginated,
    find: mockFind,
    findById: mockFindById,
  },
}));

jest.mock('@mwashburn160/api-core', () => {
  const mockIsSystemAdmin = jest.fn((_req?: any) => false);
  return {
    getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
    ErrorCode: {
      MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
      INTERNAL_ERROR: 'INTERNAL_ERROR',
    },
    isSystemAdmin: mockIsSystemAdmin,
    errorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
    validateQuery: jest.fn(() => ({ ok: true, value: {} })),
    PipelineFilterSchema: {},
    normalizeArrayFields: jest.fn((p: any) => p),
    sendEntityNotFound: jest.fn((res: any, entity: string) => {
      res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
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
    sendInternalError: jest.fn((res: any, msg: string) => {
      res.status(500).json({ success: false, statusCode: 500, message: msg });
    }),
    parsePaginationParams: jest.fn(() => ({
      limit: 25,
      offset: 0,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    })),
    applyAccessControl: jest.fn((filter: any, req: any) => {
      if (!mockIsSystemAdmin(req)) {
        return { ...filter, accessModifier: 'private' };
      }
      return filter;
    }),
    requirePublicAccess: jest.fn((req: any, res: any, resource: any) => {
      if (!mockIsSystemAdmin(req) && resource.accessModifier !== 'private') {
        res.status(404).json({ success: false, statusCode: 404, message: 'Pipeline not found.' });
        return false;
      }
      return true;
    }),
    incrementQuota: jest.fn(),
  };
});

const mockGetContext = (req: any) => req.context;
const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

jest.mock('@mwashburn160/api-server', () => ({
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
}));

jest.mock('@mwashburn160/pipeline-core', () => ({
  CoreConstants: {
    CACHE_CONTROL_LIST: 'private, max-age=30, stale-while-revalidate=60',
    CACHE_CONTROL_DETAIL: 'private, max-age=60, stale-while-revalidate=120',
  },
}));

import { isSystemAdmin, sendBadRequest, incrementQuota, validateQuery } from '@mwashburn160/api-core';
import { createReadPipelineRoutes } from '../src/routes/read-pipelines';

// Helpers

const mockQuotaService = {
  increment: jest.fn().mockResolvedValue(undefined),
  check: jest.fn(),
  getUsage: jest.fn(),
} as any;

const router = createReadPipelineRoutes(mockQuotaService);

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

describe('GET /pipelines (list)', () => {
  const handler = getHandler('get', '/');

  beforeEach(() => jest.clearAllMocks());

  it('returns paginated pipelines', async () => {
    const pipelines = [
      { id: '1', pipelineName: 'build', accessModifier: 'private' },
      { id: '2', pipelineName: 'deploy', accessModifier: 'private' },
    ];
    mockFindPaginated.mockResolvedValue({
      data: pipelines,
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
      success: true,
      statusCode: 200,
      data: expect.objectContaining({
        pipelines: expect.arrayContaining([
          expect.objectContaining({ id: '1' }),
          expect.objectContaining({ id: '2' }),
        ]),
        pagination: { total: 2, limit: 25, offset: 0, hasMore: false },
      }),
    }));
  });

  it('forces accessModifier=private for non-system-admins', async () => {
    mockFindPaginated.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });
    (isSystemAdmin as jest.Mock).mockReturnValue(false);

    await handler(mockReq(), mockRes());

    expect(mockFindPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ accessModifier: 'private' }),
      'org-1',
      expect.any(Object),
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
    (validateQuery as jest.Mock).mockReturnValueOnce({ ok: false, error: 'Bad filter' });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Bad filter');
  });

  it('returns 500 on service error', async () => {
    mockFindPaginated.mockRejectedValue(new Error('DB connection lost'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('increments quota after successful response', async () => {
    mockFindPaginated.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });

    await handler(mockReq(), mockRes());

    expect(incrementQuota).toHaveBeenCalledWith(mockQuotaService, 'org-1', 'apiCalls', 'Bearer tok', expect.any(Function));
  });
});

describe('GET /pipelines/find', () => {
  const handler = getHandler('get', '/find');

  beforeEach(() => jest.clearAllMocks());

  it('returns the first matching pipeline', async () => {
    const pipeline = { id: '1', pipelineName: 'build' };
    mockFind.mockResolvedValue([pipeline]);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        pipeline: expect.objectContaining({ id: '1' }),
      }),
    }));
  });

  it('returns 404 when no pipeline found', async () => {
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

describe('GET /pipelines/:id', () => {
  const handler = getHandler('get', '/:id');

  beforeEach(() => jest.clearAllMocks());

  it('returns a pipeline by ID', async () => {
    const pipeline = { id: 'uuid-1', pipelineName: 'build', accessModifier: 'private' };
    mockFindById.mockResolvedValue(pipeline);

    const req = mockReq({ params: { id: 'uuid-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        pipeline: expect.objectContaining({ id: 'uuid-1' }),
      }),
    }));
  });

  it('returns 404 when pipeline not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when non-admin accesses public pipeline', async () => {
    const pipeline = { id: 'uuid-1', pipelineName: 'shared', accessModifier: 'public' };
    mockFindById.mockResolvedValue(pipeline);
    (isSystemAdmin as jest.Mock).mockReturnValue(false);

    const req = mockReq({ params: { id: 'uuid-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('allows system admin to view public pipeline', async () => {
    const pipeline = { id: 'uuid-1', pipelineName: 'shared', accessModifier: 'public' };
    mockFindById.mockResolvedValue(pipeline);
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

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Pipeline ID is required.', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on service error', async () => {
    mockFindById.mockRejectedValue(new Error('Connection refused'));

    const req = mockReq({ params: { id: 'uuid-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
