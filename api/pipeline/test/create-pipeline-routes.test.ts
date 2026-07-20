// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/create-pipeline.
 *
 * Extracts the POST / handler from the router and tests it directly
 * with mock req/res objects  no HTTP server needed.
 */

// Mocks  must be defined before imports

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockCreateAsDefault = jest.fn();
const mockIncrement = jest.fn().mockResolvedValue(undefined);
const mockReserveQuota = jest.fn<(...args: any[]) => any>().mockResolvedValue({ exceeded: false, quota: { type: 'pipelines', limit: 100, used: 1, remaining: 99 } });
const mockDecrementQuota = jest.fn();
const mockSendQuotaExceeded = jest.fn((res: any, _t: string, q: any) => {
  res.status(429).json({ success: false, statusCode: 429, quota: q });
});

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    createAsDefault: mockCreateAsDefault,
  },
}));

const mockEmitPipelineAudit = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPipelineAudit: mockEmitPipelineAudit,
  getAuditClient: () => ({ record: jest.fn() }),
}));

const mockValidatePipeline = jest.fn<(...args: any[]) => any>().mockResolvedValue({ blocked: false, violations: [] });

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  ValidationError: class ValidationError extends Error {},
  extractDbError: jest.fn(() => ({})),
  resolveAccessModifier: jest.fn((_req: any, am?: string) => am || 'private'),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
    const response: any = { success: true, statusCode };
    if (data !== undefined) response.data = data;
    if (message) response.message = message;
    res.status(statusCode).json(response);
  }),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
    res.status(400).json({ success: false, statusCode: 400, message: msg, code });
  }),
  sendError: jest.fn((res: any, statusCode: number, msg: string, code?: string, details?: any) => {
    res.status(statusCode).json({ success: false, statusCode, message: msg, code, ...details });
  }),
  sendInternalError: jest.fn((res: any, msg: string, details?: any) => {
    res.status(500).json({ success: false, statusCode: 500, message: msg, ...details });
  }),
  validateBody: jest.fn((req: any) => {
    if (!req.body || !req.body.project || !req.body.organization) {
      return { ok: false, error: 'project and organization are required' };
    }
    return { ok: true, value: req.body };
  }),
  PipelineCreateSchema: {},
  incrementQuota: jest.fn(),
  // reserve+rollback pattern. Reserve returns "not exceeded" by
  // default; tests that exercise the over-quota path can override via
  // `mockReserveQuota.mockResolvedValueOnce({ exceeded: true, quota:... })`.
  reserveQuota: (...args: unknown[]) => mockReserveQuota(...args),
  decrementQuota: (...args: unknown[]) => mockDecrementQuota(...args),
  sendQuotaExceeded: (...args: unknown[]) => mockSendQuotaExceeded(...(args as [unknown, string, unknown])),
  createComplianceClient: jest.fn(() => ({
    validatePipeline: mockValidatePipeline,
  })),
}));

const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  getContext: (req: any) => req.context,
  createProtectedRoute: () => [],
  createAuthenticatedWithOrgRoute: () => [],
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
      const msg = error instanceof Error ? error.message: String(error);
      return mockSendInternalErrorForRoute(res, msg);
    }
  },
  incrementQuotaFromCtx: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  AccessModifier: {},
  replaceNonAlphanumeric: jest.fn((str: string, replacement: string) =>
    str.replace(/[^a-zA-Z0-9]/g, replacement),
  ),
  // Template-validator dependencies  minimal stubs that accept any input
  allowedScopeRoots: () => () => true,
  validateTemplates: () => ({ valid: true, errors: [] }),
  detectCycles: () => [],
  resolveSelfReferencing: () => ({ errors: [] }),
  tokenize: () => [],
}));

const { sendBadRequest, validateBody } = await import('@pipeline-builder/api-core');
const { createCreatePipelineRoutes } = await import('../src/routes/create-pipeline.js');

// Helpers

const mockQuotaService = {
  increment: mockIncrement,
  check: jest.fn(),
  getUsage: jest.fn(),
} as any;

const router = createCreatePipelineRoutes(mockQuotaService);

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find( (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  // The final layer is the withRoute business handler; any preceding layers are
  // guard middleware (e.g. requirePermission). Grab the last so the test drives
  // the handler directly without an Express `next`.
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    body: {
      project: 'my-project',
      organization: 'my-org',
      description: 'test pipeline',
    },
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

// Tests

describe('POST /pipelines (create)', () => {
  const handler = getHandler('post', '/');

  beforeEach(() => jest.clearAllMocks());

  it('creates a pipeline and returns 201', async () => {
    const createdPipeline = {
      id: 'uuid-1',
      project: 'my_project',
      organization: 'my_org',
      pipelineName: 'my_org-my_project-pipeline',
      accessModifier: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    };
    mockCreateAsDefault.mockResolvedValue(createdPipeline);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith( expect.objectContaining({
      success: true,
      statusCode: 201,
      data: expect.objectContaining({
        pipeline: expect.objectContaining({ id: 'uuid-1' }),
      }),
    }),
    );
  });

  it('emits an attributed pipeline.create audit event after a successful create', async () => {
    mockCreateAsDefault.mockResolvedValue({
      id: 'uuid-1',
      project: 'my_project',
      organization: 'my_org',
      pipelineName: 'my_org-my_project-pipeline',
      accessModifier: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });

    await handler(mockReq(), mockRes());

    expect(mockEmitPipelineAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitPipelineAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pipeline.create',
        actorId: 'user-1',
        orgId: 'org-1',
        targetType: 'pipeline',
        targetId: 'uuid-1',
      }),
    );
  });

  it('does NOT emit an audit event when the create is blocked / fails', async () => {
    mockValidatePipeline.mockResolvedValueOnce({
      blocked: true,
      violations: [{ message: 'nope' }],
    });

    await handler(mockReq(), mockRes());

    expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
  });

  it('returns 400 when body validation fails', async () => {
    (validateBody as jest.Mock).mockReturnValueOnce({
      ok: false,
      error: 'project is required',
    });

    const req = mockReq({ body: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'project is required', 'VALIDATION_ERROR');
  });

  it('returns 400 when project contains only special characters', async () => {
    const req = mockReq({
      body: { project: '!!!', organization: 'my-org' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith( res,
      'Project and organization must contain alphanumeric characters',
      'VALIDATION_ERROR',
    );
  });

  it('returns 400 when organization contains only special characters', async () => {
    const req = mockReq({
      body: { project: 'my-project', organization: '---' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith( res,
      'Project and organization must contain alphanumeric characters',
      'VALIDATION_ERROR',
    );
  });

  it('returns 400 when orgId is missing', async () => {
    mockCreateAsDefault.mockResolvedValue({});
    const req = mockReq({
      context: {
        identity: { orgId: '', userId: 'user-1' },
        log: jest.fn(),
        requestId: 'req-1',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Organization ID is required' }));
  });

  it('increments quota after successful creation', async () => {
    mockCreateAsDefault.mockResolvedValue({
      id: 'uuid-2',
      project: 'p',
      organization: 'o',
      pipelineName: 'pipe',
      accessModifier: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // reserve replaces post-hoc increment. The reserved slot is
    // implicit success  the test asserts reserve was called with the
    // right args.
    expect(mockReserveQuota).toHaveBeenCalledWith( mockQuotaService, 'org-1', 'pipelines', expect.any(String),
    );
  });

  it('returns 500 on service error', async () => {
    mockCreateAsDefault.mockRejectedValue(new Error('DB failure'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('generates pipelineName from project and org when not provided', async () => {
    mockCreateAsDefault.mockResolvedValue({
      id: 'uuid-3',
      project: 'my_project',
      organization: 'my_org',
      pipelineName: 'my_org-my_project-pipeline',
      accessModifier: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // Verify the service was called with a generated pipelineName
    expect(mockCreateAsDefault).toHaveBeenCalledWith( expect.objectContaining({
      pipelineName: expect.stringContaining('pipeline'),
    }),
    expect.any(String),
    expect.any(String),
    expect.any(String),
    );
  });

  it('uses provided pipelineName when specified', async () => {
    mockCreateAsDefault.mockResolvedValue({
      id: 'uuid-4',
      project: 'p',
      organization: 'o',
      pipelineName: 'custom-name',
      accessModifier: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });

    const req = mockReq({
      body: { project: 'p', organization: 'o', pipelineName: 'custom-name' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockCreateAsDefault).toHaveBeenCalledWith( expect.objectContaining({ pipelineName: 'custom-name' }),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });
});
