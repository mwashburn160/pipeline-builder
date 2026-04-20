// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/create-pipeline.
 *
 * Extracts the POST / handler from the router and tests it directly
 * with mock req/res objects — no HTTP server needed.
 */

// Mocks — must be defined before imports

const mockCreateAsDefault = jest.fn();
const mockIncrement = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/services/pipeline-service', () => ({
  pipelineService: {
    createAsDefault: mockCreateAsDefault,
  },
}));

const mockValidatePipeline = jest.fn().mockResolvedValue({ blocked: false, violations: [] });

jest.mock('@pipeline-builder/api-core', () => ({
  extractDbError: jest.fn(() => ({})),
  ErrorCode: {
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    COMPLIANCE_VIOLATION: 'COMPLIANCE_VIOLATION',
    COMPLIANCE_SERVICE_UNAVAILABLE: 'COMPLIANCE_SERVICE_UNAVAILABLE',
  },
  createLogger: jest.fn(() => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() })),
  resolveAccessModifier: jest.fn((_req: any, am?: string) => am || 'private'),
  errorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
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

jest.mock('@pipeline-builder/api-server', () => ({
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
  incrementQuotaFromCtx: jest.fn(),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  AccessModifier: {},
  replaceNonAlphanumeric: jest.fn((str: string, replacement: string) =>
    str.replace(/[^a-zA-Z0-9]/g, replacement),
  ),
}));

import { sendBadRequest, validateBody } from '@pipeline-builder/api-core';
import { incrementQuotaFromCtx } from '@pipeline-builder/api-server';
import { createCreatePipelineRoutes } from '../src/routes/create-pipeline';

// Helpers

const mockQuotaService = {
  increment: mockIncrement,
  check: jest.fn(),
  getUsage: jest.fn(),
} as any;

const router = createCreatePipelineRoutes(mockQuotaService);

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
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        statusCode: 201,
        data: expect.objectContaining({
          pipeline: expect.objectContaining({ id: 'uuid-1' }),
        }),
      }),
    );
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

    expect(sendBadRequest).toHaveBeenCalledWith(
      res,
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

    expect(sendBadRequest).toHaveBeenCalledWith(
      res,
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

    expect(incrementQuotaFromCtx).toHaveBeenCalledWith(mockQuotaService, expect.objectContaining({ orgId: 'org-1' }), 'pipelines');
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
    expect(mockCreateAsDefault).toHaveBeenCalledWith(
      expect.objectContaining({
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

    expect(mockCreateAsDefault).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineName: 'custom-name' }),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });
});
