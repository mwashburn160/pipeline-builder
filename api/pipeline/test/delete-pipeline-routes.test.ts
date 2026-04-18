// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/delete-pipeline.
 *
 * Extracts the DELETE /:id handler from the router and tests it directly
 * with mock req/res objects — no HTTP server needed.
 */

// Mocks — must be defined before imports

const mockFindById = jest.fn();
const mockDelete = jest.fn();

jest.mock('../src/services/pipeline-service', () => ({
  pipelineService: {
    findById: mockFindById,
    delete: mockDelete,
  },
}));

const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

jest.mock('@mwashburn160/api-core', () => ({
  extractDbError: jest.fn(() => ({})),
  ErrorCode: {
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  },
  createLogger: jest.fn(() => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() })),
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  resolveAccessModifier: jest.fn((_req: any, am?: string) => am || 'private'),
  requirePublicAccess: jest.fn((_req: any, _res: any, _resource: any) => true),
  errorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
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
  sendInternalError: jest.fn((res: any, msg: string, details?: any) => {
    res.status(500).json({ success: false, statusCode: 500, message: msg, ...details });
  }),
  sendError: jest.fn((res: any, status: number, msg: string, code?: string) => {
    res.status(status).json({ success: false, statusCode: status, message: msg, code });
  }),
  validateBody: jest.fn((req: any) => {
    return { ok: true, value: req.body };
  }),
  PipelineUpdateSchema: {},
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
  AccessModifier: {},
}));

import { sendBadRequest, requirePublicAccess, sendEntityNotFound } from '@mwashburn160/api-core';
import { createDeletePipelineRoutes } from '../src/routes/delete-pipeline';

// Helpers

const router = createDeletePipelineRoutes();

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

const existingPipeline = {
  id: 'pipeline-uuid-1',
  pipelineName: 'test',
  orgId: 'org-1',
  accessModifier: 'private',
  isActive: true,
  isDefault: false,
};

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: { id: 'pipeline-uuid-1' },
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

// Tests

describe('DELETE /pipelines/:id (delete)', () => {
  const handler = getHandler('delete', '/:id');

  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on successful delete', async () => {
    mockFindById.mockResolvedValue(existingPipeline);
    mockDelete.mockResolvedValue(existingPipeline);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1');
    expect(mockDelete).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1', 'user-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        statusCode: 200,
        message: 'Pipeline deleted.',
      }),
    );
  });

  it('returns 400 when ID is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(
      res,
      'Pipeline ID is required.',
      'MISSING_REQUIRED_FIELD',
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when pipeline not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1');
    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Pipeline');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 200 even when delete returns null (route does not check return value)', async () => {
    mockFindById.mockResolvedValue(existingPipeline);
    mockDelete.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockDelete).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1', 'user-1');
    // The delete route does not check the return value of pipelineService.delete();
    // it always proceeds to sendSuccess after the await completes.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        statusCode: 200,
        message: 'Pipeline deleted.',
      }),
    );
  });

  it('returns 403 when requirePublicAccess returns false', async () => {
    mockFindById.mockResolvedValue(existingPipeline);
    (requirePublicAccess as jest.Mock).mockReturnValueOnce(false);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(requirePublicAccess).toHaveBeenCalledWith(req, res, existingPipeline);
    // The route returns early when requirePublicAccess is false
    // (requirePublicAccess itself sends the 403 response)
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 500 on service error', async () => {
    mockFindById.mockRejectedValue(new Error('DB failure'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
