// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for quota read routes (GET /quotas/*).
 *
 * Middleware (requireAuth, authorizeOrg) is mocked to pass through —
 * those are tested separately in authorize-org.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

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

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  isSystemAdmin: mockIsSystemAdmin,
  AppError: MockAppError,
  NotFoundError: MockNotFoundError,
  ValidationError: class MockValidationError extends MockAppError {
    constructor(message: string) {
      super(400, 'VALIDATION_ERROR', message);
      this.name = 'ValidationError';
    }
  },
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
  getParam: mockGetParam,
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'],
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
  QUOTA_TIERS: {},
  VALID_TIERS: ['developer', 'pro', 'team', 'enterprise'],
  isValidTier: (t: string) => ['developer', 'pro', 'team', 'enterprise'].includes(t),
  // Org → team hierarchy traversal helpers. quota-service → org-hierarchy.ts
  // imports these from api-core; the GET routes never walk a hierarchy (every
  // org is flat), but the bindings must resolve for the module graph to load.
  toOrgIdString: (v: unknown) => (v == null ? undefined : String(v)),
  resolveRootOrgIdWith: async (orgId: string) => orgId,
  expandOrgScopeWith: async (orgId: string) => [orgId],
  parseQueryIntClamped: (v: unknown, def: number, max: number) => {
    const raw = v === undefined ? def : parseInt(String(v), 10);
    const n = Number.isFinite(raw) ? raw : def;
    return Math.max(1, Math.min(n, max));
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
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

jest.unstable_mockModule('../src/middleware/authorize-org.js', () => ({
  authorizeOrg: () => (_req: any, _res: any, next: any) => next(),
}));

const mockFind = jest.fn();
const mockFindById = jest.fn();

jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: {
    find: mockFind,
    findById: mockFindById,
  },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quota: {
      defaults: { plugins: 100, pipelines: 10, apiCalls: -1 },
      resetDays: 3,
    },
  },
}));

const { createReadQuotaRoutes } = await import('../src/routes/read-quotas.js');
const getQuotaRouter = createReadQuotaRoutes();

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
    // findAll now paginates via .skip().limit() on the Mongoose query object,
    // then awaits .lean(). Build a chainable mock where each method returns the
    // same query so the source can call them in any order.
    const query: any = {
      select: jest.fn(() => query),
      sort: jest.fn(() => query),
      skip: jest.fn(() => query),
      limit: jest.fn(() => query),
      lean: jest.fn().mockResolvedValue(orgs),
    };
    mockFind.mockReturnValue(query);

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
    const query: any = {
      select: jest.fn(() => query),
      sort: jest.fn(() => query),
      skip: jest.fn(() => query),
      limit: jest.fn(() => query),
      lean: jest.fn().mockRejectedValue(new Error('DB error')),
    };
    mockFind.mockReturnValue(query);

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
