// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for quota write routes (PUT/POST /quotas/*).
 *
 * Middleware (requireAuth, authorizeOrg) is mocked to pass through —
 * those are tested separately in authorize-org.test.ts.
 */

// Mocks — must be defined before imports
const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockSendQuotaExceeded = jest.fn();
const mockGetParam = jest.fn((params: Record<string, string>, key: string) => params[key]);
const mockIsSystemOrg = jest.fn().mockReturnValue(false);

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
  sendQuotaExceeded: mockSendQuotaExceeded,
  isSystemOrg: mockIsSystemOrg,
  AppError: MockAppError,
  NotFoundError: MockNotFoundError,
  ErrorCode: {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    DATABASE_ERROR: 'DATABASE_ERROR',
    ORG_NOT_FOUND: 'ORG_NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
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
  QUOTA_TIERS: {
    developer: { limits: { plugins: 100, pipelines: 10, apiCalls: -1 } },
    pro: { limits: { plugins: 500, pipelines: 50, apiCalls: -1 } },
    unlimited: { limits: { plugins: -1, pipelines: -1, apiCalls: -1 } },
  },
  VALID_TIERS: ['developer', 'pro', 'unlimited'],
  isValidTier: (t: string) => ['developer', 'pro', 'unlimited'].includes(t),
  getTierLimits: (t: string) => ({
    developer: { plugins: 100, pipelines: 10, apiCalls: -1 },
    pro: { plugins: 500, pipelines: 50, apiCalls: -1 },
    unlimited: { plugins: -1, pipelines: -1, apiCalls: -1 },
  } as Record<string, any>)[t],
  validateBody: jest.fn((req: any, schema: any) => {
    try {
      const value = schema.parse(req.body);
      return { ok: true, value };
    } catch (err: any) {
      const firstIssue = err.issues?.[0];
      const message = firstIssue
        ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
        : 'Validation failed';
      return { ok: false, error: message };
    }
  }),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
    mockSendError(res, 400, msg, code);
  }),
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

const mockFindById = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();

jest.mock('../src/models/organization', () => ({
  Organization: {
    findById: mockFindById,
    findOneAndUpdate: mockFindOneAndUpdate,
    updateOne: mockUpdateOne,
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

import updateQuotaRouter from '../src/routes/update-quota';

// Helpers

function mockReq(overrides: Record<string, unknown> = {}): any {
  return { params: {}, query: {}, headers: {}, body: {}, user: {}, ...overrides };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Extract the final handler for a route (skipping middleware). */
function getHandler(method: string, path: string) {
  const layer = (updateQuotaRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const futureDate = new Date(Date.now() + 86400000 * 7);

function makeSaveableOrg(overrides: Partial<any> = {}) {
  const org: any = {
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
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return org;
}

// Tests — PUT /quotas/:orgId

describe('PUT /quotas/:orgId (update org)', () => {
  const handler = getHandler('put', '/:orgId');

  beforeEach(() => jest.clearAllMocks());

  it('updates org name and slug', async () => {
    const org = makeSaveableOrg();
    mockFindById.mockResolvedValue(org);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { name: 'New Name', slug: 'new-name' },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(org.name).toBe('New Name');
    expect(org.slug).toBe('new-name');
    expect(org.save).toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({ quota: expect.any(Object) }),
      'Updated successfully',
    );
  });

  it('updates tier and applies tier defaults', async () => {
    const org = makeSaveableOrg();
    mockFindById.mockResolvedValue(org);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { tier: 'pro' },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(org.tier).toBe('pro');
    expect(org.quotas.plugins).toBe(500);
    expect(org.quotas.pipelines).toBe(50);
    expect(org.save).toHaveBeenCalled();
  });

  it('returns 404 when org not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq({
      params: { orgId: 'missing' },
      body: { name: 'Test' },
      user: { organizationId: 'missing' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Organization not found.', 'NOT_FOUND');
  });

  it('returns 400 for invalid body (empty)', async () => {
    const req = mockReq({ params: { orgId: 'org-123' }, body: {}, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('returns 500 on database error', async () => {
    mockFindById.mockRejectedValue(new Error('DB error'));

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { name: 'Test' },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });
});

// Tests — POST /quotas/:orgId/reset

describe('POST /quotas/:orgId/reset', () => {
  const handler = getHandler('post', '/:orgId/reset');

  beforeEach(() => jest.clearAllMocks());

  it('resets all quota usage when no quotaType specified', async () => {
    const org = makeSaveableOrg();
    mockFindById.mockResolvedValue(org);

    const req = mockReq({ params: { orgId: 'org-123' }, body: {}, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(org.usage.plugins.used).toBe(0);
    expect(org.usage.pipelines.used).toBe(0);
    expect(org.usage.apiCalls.used).toBe(0);
    expect(org.save).toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({ quota: expect.any(Object) }),
      'All quota usage reset successfully',
    );
  });

  it('resets specific quota type', async () => {
    const org = makeSaveableOrg();
    mockFindById.mockResolvedValue(org);

    const req = mockReq({ params: { orgId: 'org-123' }, body: { quotaType: 'plugins' }, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(org.usage.plugins.used).toBe(0);
    expect(org.save).toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.any(Object),
      'plugins usage reset successfully',
    );
  });

  it('returns 404 when org not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq({ params: { orgId: 'missing' }, body: {}, user: { organizationId: 'missing' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Organization not found.', 'NOT_FOUND');
  });

  it('returns 400 for invalid quotaType', async () => {
    const req = mockReq({ params: { orgId: 'org-123' }, body: { quotaType: 'invalid' }, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('returns 500 on database error', async () => {
    mockFindById.mockRejectedValue(new Error('DB error'));

    const req = mockReq({ params: { orgId: 'org-123' }, body: {}, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });
});

// Tests — POST /quotas/:orgId/increment

describe('POST /quotas/:orgId/increment', () => {
  const handler = getHandler('post', '/:orgId/increment');

  beforeEach(() => jest.clearAllMocks());

  it('increments quota usage successfully', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    const org = makeSaveableOrg({
      quotas: { plugins: 100, pipelines: 10, apiCalls: -1 },
      usage: {
        plugins: { used: 6, resetAt: futureDate },
        pipelines: { used: 2, resetAt: futureDate },
        apiCalls: { used: 50, resetAt: futureDate },
      },
    });
    mockFindOneAndUpdate.mockResolvedValue(org);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({
        quota: expect.objectContaining({ type: 'plugins', limit: 100 }),
      }),
      'Usage incremented successfully',
    );
  });

  it('returns quota exceeded when limit reached', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    mockFindOneAndUpdate.mockResolvedValue(null);
    // Org exists but quota exceeded
    const existingOrg = makeSaveableOrg({
      quotas: { plugins: 10, pipelines: 10, apiCalls: -1 },
      usage: {
        plugins: { used: 10, resetAt: futureDate },
        pipelines: { used: 2, resetAt: futureDate },
        apiCalls: { used: 0, resetAt: futureDate },
      },
    });
    mockFindById.mockResolvedValue(existingOrg);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendQuotaExceeded).toHaveBeenCalledWith(
      res,
      'plugins',
      expect.objectContaining({ type: 'plugins', limit: 10, used: 10, remaining: 0 }),
      expect.any(String),
    );
  });

  it('returns 404 when org does not exist', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockResolvedValue(null);

    const req = mockReq({
      params: { orgId: 'missing' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'missing' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Organization not found.', 'NOT_FOUND');
  });

  it('returns 400 for missing quotaType', async () => {
    const req = mockReq({ params: { orgId: 'org-123' }, body: {}, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('returns 400 for invalid amount', async () => {
    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: -5 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('returns 500 on database error', async () => {
    mockFindOneAndUpdate.mockRejectedValue(new Error('DB error'));

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });

  it('bypasses quota limit for system org', async () => {
    mockIsSystemOrg.mockReturnValue(true);
    const org = makeSaveableOrg({
      quotas: { plugins: 10, pipelines: 10, apiCalls: -1 },
      usage: {
        plugins: { used: 10, resetAt: futureDate },
        pipelines: { used: 2, resetAt: futureDate },
        apiCalls: { used: 50, resetAt: futureDate },
      },
    });
    mockFindOneAndUpdate.mockResolvedValue(org);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    // Should succeed even though usage equals limit
    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200,
      expect.objectContaining({
        quota: expect.objectContaining({ type: 'plugins', limit: 10 }),
      }),
      'Usage incremented successfully',
    );
    // Should NOT call updateOne (no auto-reset) or sendQuotaExceeded
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockSendQuotaExceeded).not.toHaveBeenCalled();
  });

  it('returns 404 for system org when org does not exist', async () => {
    mockIsSystemOrg.mockReturnValue(true);
    mockFindOneAndUpdate.mockResolvedValue(null);

    const req = mockReq({
      params: { orgId: 'missing' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'missing' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Organization not found.', 'NOT_FOUND');
  });
});
