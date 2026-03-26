/**
 * Tests for quota read routes (GET /quotas/*).
 *
 * Middleware (requireAuth, authorizeOrg) is mocked to pass through —
 * those are tested separately in authorize-org.test.ts.
 */

// Mocks — must be defined before imports
const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockIsSystemAdmin = jest.fn();
const mockGetParam = jest.fn((params: Record<string, string>, key: string) => params[key]);

class MockAppError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'AppError';
  }
}

class MockNotFoundError extends MockAppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

jest.mock('@mwashburn160/api-core', () => ({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  isSystemAdmin: mockIsSystemAdmin,
  AppError: MockAppError,
  NotFoundError: MockNotFoundError,
  ErrorCode: {
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    DATABASE_ERROR: 'DATABASE_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    NOT_FOUND: 'NOT_FOUND',
  },
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
  getParam: mockGetParam,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'],
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
  createCacheService: () => ({
    getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
    invalidatePattern: () => Promise.resolve(0),
  }),
}));

jest.mock('@mwashburn160/api-server', () => ({
  withRoute: (handler: any, opts?: any) => async (req: any, res: any) => {
    const orgId = req.user?.organizationId || '';
    const requireOrgId = opts?.requireOrgId !== false;
    if (requireOrgId && !orgId) {
      mockSendError(res, 400, 'Organization ID is required. Please provide x-org-id header.', 'VALIDATION_ERROR');
      return;
    }
    const ctx = {
      identity: { orgId, userId: req.user?.sub },
      log: jest.fn(),
    };
    try {
      await handler({ req, res, ctx, orgId, userId: req.user?.sub || '' });
    } catch (err: any) {
      if (err.statusCode && err.code) {
        mockSendError(res, err.statusCode, err.message, err.code);
      } else {
        mockSendError(res, 500, err.message || 'Internal server error');
      }
    }
  },
}));

jest.mock('../src/middleware/authorize-org', () => ({
  authorizeOrg: () => (_req: any, _res: any, next: any) => next(),
}));

const mockFind = jest.fn();
const mockFindById = jest.fn();

jest.mock('../src/models/organization', () => ({
  Organization: {
    find: mockFind,
    findById: mockFindById,
  },
}));

jest.mock('../src/config', () => ({
  config: {
    quota: {
      defaults: { plugins: 100, pipelines: 10, apiCalls: -1 },
      resetDays: 3,
    },
  },
}));

import getQuotaRouter from '../src/routes/read-quotas';

// Helpers

function mockReq(overrides: Record<string, unknown> = {}): any {
  return { params: {}, query: {}, headers: {}, user: {}, ...overrides };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Extract the final handler for a specific route/method (skipping middleware). */
function getHandler(method: string, path: string) {
  const layer = (getQuotaRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const futureDate = new Date(Date.now() + 86400000 * 7);

function makeOrg(overrides: Partial<any> = {}) {
  return {
    _id: 'org-123',
    name: 'Test Org',
    slug: 'test-org',
    tier: 'developer',
    quotas: { plugins: 100, pipelines: 10, apiCalls: -1 },
    usage: {
      plugins: { used: 5, resetAt: futureDate },
      pipelines: { used: 2, resetAt: futureDate },
      apiCalls: { used: 50, resetAt: futureDate },
    },
    ...overrides,
  };
}

// Tests

describe('GET /quotas (own org)', () => {
  const handler = getHandler('get', '/');

  beforeEach(() => jest.clearAllMocks());

  it('returns own org quotas from JWT orgId', async () => {
    const org = makeOrg();
    mockFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(org) }) });

    const req = mockReq({ user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('org-123');
    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({ quota: expect.objectContaining({ orgId: 'org-123' }) }),
    );
  });

  it('returns default quotas for unknown org', async () => {
    mockFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

    const req = mockReq({ user: { organizationId: 'unknown-org' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({ quota: expect.objectContaining({ orgId: 'unknown-org', isDefault: true }) }),
    );
  });

  it('returns 400 when orgId is missing from JWT', async () => {
    const req = mockReq({ user: {} });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(
      res, 400,
      expect.stringContaining('Organization ID is required'),
      'VALIDATION_ERROR',
    );
  });

  it('returns 500 on database error', async () => {
    mockFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('DB down')) }) });

    const req = mockReq({ user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB down');
  });
});

describe('GET /quotas/all (system admin)', () => {
  const handler = getHandler('get', '/all');

  beforeEach(() => jest.clearAllMocks());

  it('returns all organizations for system admin', async () => {
    mockIsSystemAdmin.mockReturnValue(true);
    const orgs = [makeOrg({ _id: 'org-1', name: 'Org A' }), makeOrg({ _id: 'org-2', name: 'Org B' })];
    mockFind.mockReturnValue({ select: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(orgs) }) }) });

    const req = mockReq({ user: { organizationId: 'admin-org' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({ organizations: expect.any(Array), total: 2 }),
    );
  });

  it('returns 403 for non-admin user', async () => {
    mockIsSystemAdmin.mockReturnValue(false);

    const req = mockReq({ user: { organizationId: 'some-org' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(
      res, 403,
      expect.stringContaining('system administrators'),
      'INSUFFICIENT_PERMISSIONS',
    );
  });

  it('returns 500 on database error', async () => {
    mockIsSystemAdmin.mockReturnValue(true);
    mockFind.mockReturnValue({ select: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('DB error')) }) }) });

    const req = mockReq({ user: { organizationId: 'admin-org' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });
});

describe('GET /quotas/:orgId', () => {
  const handler = getHandler('get', '/:orgId');

  beforeEach(() => jest.clearAllMocks());

  it('returns quotas for a specific org', async () => {
    const org = makeOrg();
    mockFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(org) }) });

    const req = mockReq({ params: { orgId: 'org-123' }, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({ quota: expect.objectContaining({ orgId: 'org-123', tier: 'developer' }) }),
    );
  });

  it('returns default response when org not found', async () => {
    mockFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

    const req = mockReq({ params: { orgId: 'missing-org' }, user: { organizationId: 'missing-org' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({ quota: expect.objectContaining({ orgId: 'missing-org', isDefault: true }) }),
    );
  });
});

describe('GET /quotas/:orgId/:quotaType', () => {
  const handler = getHandler('get', '/:orgId/:quotaType');

  beforeEach(() => jest.clearAllMocks());

  it('returns status for a valid quota type', async () => {
    const org = makeOrg();
    mockFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(org) }) });

    const req = mockReq({ params: { orgId: 'org-123', quotaType: 'plugins' }, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({
        quotaType: 'plugins',
        status: expect.objectContaining({ limit: 100, used: 5 }),
      }),
    );
  });

  it('returns default values when org not found', async () => {
    mockFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

    const req = mockReq({ params: { orgId: 'unknown', quotaType: 'pipelines' }, user: { organizationId: 'unknown' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({
        quotaType: 'pipelines',
        status: expect.objectContaining({ limit: 10, used: 0 }),
      }),
    );
  });

  it('returns 400 for invalid quota type', async () => {
    const req = mockReq({ params: { orgId: 'org-123', quotaType: 'invalid' }, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(
      res, 400,
      expect.stringContaining('Invalid quota type'),
      'VALIDATION_ERROR',
    );
  });

  it('returns 500 on database error', async () => {
    mockFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('DB error')) }) });

    const req = mockReq({ params: { orgId: 'org-123', quotaType: 'plugins' }, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });
});
