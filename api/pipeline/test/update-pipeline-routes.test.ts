// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/update-pipeline.
 *
 * Extracts the PUT /:id handler from the router and tests it directly
 * with mock req/res objects — no HTTP server needed.
 */

// Mocks — must be defined before imports

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindById = jest.fn<AnyFn>();
const mockUpdate = jest.fn<AnyFn>();

// Plugin-contract check — resolves plugins through the DB; stubbed here
// and driven per test. The real formatter is exercised in plugin-contract-check.test.ts.
const mockFindContractViolations = jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([]);
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({
  findPluginContractViolations: (...args: unknown[]) => mockFindContractViolations(...args),
  formatContractViolations: (v: unknown[]) => `Pipeline does not meet the contract of ${v.length} plugin step(s)`,
}));

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    findById: mockFindById,
    update: mockUpdate,
  },
}));

const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  ValidationError: class ValidationError extends Error {},
  extractDbError: jest.fn(() => ({})),
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  resolveVisibility: jest.fn((_req: any, am?: string) => am || 'private'),
  requireVisibilityWriteAccess: jest.fn((_req: any, _res: any, _resource: any) => true),
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
  normalizeArrayFields: jest.fn((p: any) => p),
  sendEntityNotFound: jest.fn((res: any, entity: string) => {
    res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
  }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  checkQuota: () => (_req: any, _res: any, next: () => void) => next(),
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

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  pipelineScopeMetadata: (p: Record<string, any>) => ({ ...(p.global ?? {}), ...(p.defaults?.metadata ?? {}), ...(p.synth?.metadata ?? {}) }),
  allowedScopeRoots: () => () => true,
  validateTemplates: () => ({ valid: true, errors: [] }),
  detectCycles: () => [],
  resolveSelfReferencing: () => ({ errors: [] }),
  tokenize: () => [],
}));

const { sendBadRequest, validateBody, requireVisibilityWriteAccess, sendEntityNotFound } = await import('@pipeline-builder/api-core');
const { createUpdatePipelineRoutes } = await import('../src/routes/update-pipeline.js');

// Helpers

const router = createUpdatePipelineRoutes();

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  // The route handler is LAST in the stack: gate middleware (permission, audit,
  // quota) sits ahead of it now that gates are declared per route.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const existingPipeline = {
  id: 'pipeline-uuid-1',
  pipelineName: 'test',
  orgId: 'org-1',
  visibility: 'private',
  isActive: true,
  isDefault: false,
};

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: { id: 'pipeline-uuid-1' },
    query: {},
    body: {
      pipelineName: 'updated-name',
      description: 'updated description',
    },
    headers: { authorization: 'Bearer tok' },
    context: {
      identity: { orgId: 'ORG-1', userId: 'user-1' },
      log: jest.fn<AnyFn>(),
      requestId: 'req-1',
    },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}

// Tests

describe('PUT /pipelines/:id (update)', () => {
  const handler = getHandler('put', '/:id');

  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 200 on successful update', async () => {
    const updatedPipeline = {
      ...existingPipeline,
      pipelineName: 'updated-name',
      description: 'updated description',
    };
    mockFindById.mockResolvedValue(existingPipeline);
    mockUpdate.mockResolvedValue(updatedPipeline);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1');
    expect(mockUpdate).toHaveBeenCalledWith(
      'pipeline-uuid-1',
      expect.objectContaining({ pipelineName: 'updated-name' }),
      'org-1',
      'user-1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        statusCode: 200,
        data: expect.objectContaining({
          pipeline: expect.objectContaining({ pipelineName: 'updated-name' }),
        }),
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

  it('returns 400 when body validation fails', async () => {
    (validateBody as jest.Mock<AnyFn>).mockReturnValueOnce({
      ok: false,
      error: 'pipelineName must be a string',
    });

    const req = mockReq({ body: { pipelineName: 123 } });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(
      res,
      'pipelineName must be a string',
      'VALIDATION_ERROR',
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 TEMPLATE_CONTRACT_VIOLATION when new props break a plugin contract', async () => {
    mockFindContractViolations.mockResolvedValueOnce([
      { path: 'stages[0].steps[0]', step: 'deploy/helm', plugin: 'helm', version: '1.0.0', missing: ['metadata.namespace'], invalid: [] },
    ]);
    const props = { synth: { plugin: { name: 'cdk-synth' } } };
    const res = mockRes();
    await handler(mockReq({ body: { props } }), res);

    expect(mockFindContractViolations).toHaveBeenCalledWith(props, 'org-1', undefined);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TEMPLATE_CONTRACT_VIOLATION' }));
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('skips the plugin-contract check when props are not being updated', async () => {
    mockFindById.mockResolvedValue(existingPipeline);
    mockUpdate.mockResolvedValue(existingPipeline);
    await handler(mockReq(), mockRes());
    expect(mockFindContractViolations).not.toHaveBeenCalled();
  });

  it('returns 404 when pipeline not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1');
    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Pipeline');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when update returns null', async () => {
    mockFindById.mockResolvedValue(existingPipeline);
    mockUpdate.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockUpdate).toHaveBeenCalled();
    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Pipeline');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 when requireVisibilityWriteAccess returns false', async () => {
    mockFindById.mockResolvedValue(existingPipeline);
    (requireVisibilityWriteAccess as jest.Mock<AnyFn>).mockReturnValueOnce(false);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(requireVisibilityWriteAccess).toHaveBeenCalledWith(req, res, existingPipeline, 'user-1', 'pipelines:publish');
    // The route returns early when requireVisibilityWriteAccess is false
    // (requireVisibilityWriteAccess itself sends the 403 response)
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 500 on service error', async () => {
    mockFindById.mockRejectedValue(new Error('DB failure'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
