// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/purge-pipeline.
 *
 * Extracts the POST /:id/purge handler from the router and tests it directly
 * with mock req/res objects — no HTTP server needed. Mirrors the sibling
 * restore-pipeline.test.ts mocking approach.
 *
 * The route delegates its load → publish-gate → hard-delete → 404 skeleton to
 * api-core's shared `loadAndPurge`. Because the whole api-core package is
 * wholesale-mocked here (its real graph is too heavy to link in-suite), this
 * suite installs a FAITHFUL re-implementation of `loadAndPurge` in the mock that
 * delegates to the passed-in service singleton + the same `requirePublicAccess`
 * / `sendEntityNotFound` / `sendBadRequest` spies the real helper uses. That lets
 * the suite exercise every branch the real helper takes (400 missing-id, 404
 * tombstone-miss, 403 publish-gate, 404 purge-race-miss, happy path) end-to-end
 * through the route.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks — must be defined before imports

const mockFindDeletedById = jest.fn();
const mockPurgeById = jest.fn();

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    findDeletedById: mockFindDeletedById,
    purgeById: mockPurgeById,
  },
}));

const mockEmitPipelineAudit = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPipelineAudit: mockEmitPipelineAudit,
  getAuditClient: () => ({ record: jest.fn() }),
}));

const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

// Shared spies used both as api-core exports AND inside the faithful
// loadAndPurge re-implementation below.
const sendBadRequest = jest.fn((res: any, msg: string, code?: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg, code });
});
const sendEntityNotFound = jest.fn((res: any, entity: string) => {
  res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
});
const requirePublicAccess = jest.fn((_req: any, _res: any, _resource: any, _perm?: string) => true);
const sendSuccess = jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
  const response: any = { success: true, statusCode };
  if (data !== undefined) response.data = data;
  if (message) response.message = message;
  res.status(statusCode).json(response);
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  requirePublicAccess,
  sendSuccess,
  sendBadRequest,
  sendEntityNotFound,
  // Faithful re-implementation of the shared purge skeleton (see file header).
  loadAndPurge: jest.fn(async (
    req: any,
    res: any,
    orgId: string,
    service: any,
    label: string,
    publishPermission: string,
  ) => {
    const id = req.params?.id;
    if (!id) {
      sendBadRequest(res, `${label} ID is required.`, 'MISSING_REQUIRED_FIELD');
      return null;
    }
    const existing = await service.findDeletedById(id, orgId);
    if (!existing) {
      sendEntityNotFound(res, label);
      return null;
    }
    if (!requirePublicAccess(req, res, existing, publishPermission)) return null;
    const purgedId = await service.purgeById(id, orgId);
    if (!purgedId) {
      sendEntityNotFound(res, label);
      return null;
    }
    return { existing, purgedId };
  }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
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

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  AccessModifier: {},
}));

const { createPurgePipelineRoutes } = await import('../src/routes/purge-pipeline.js');

// Helpers

const router = createPurgePipelineRoutes();

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const existingPipeline = {
  id: 'pipeline-uuid-1',
  pipelineName: 'test',
  orgId: 'org-1',
  accessModifier: 'private',
  keywords: ['a', 'b'],
  isActive: false,
  isDefault: false,
};

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: { id: 'pipeline-uuid-1' },
    query: {},
    body: {},
    headers: { authorization: 'Bearer tok' },
    user: { sub: 'user-1' },
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

describe('POST /pipelines/:id/purge (purge)', () => {
  const handler = getHandler('post', '/:id/purge');

  beforeEach(() => jest.clearAllMocks());

  it('hard-deletes the tombstone and returns 200 with the success message', async () => {
    mockFindDeletedById.mockResolvedValue(existingPipeline);
    mockPurgeById.mockResolvedValue('pipeline-uuid-1');

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindDeletedById).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1');
    expect(mockPurgeById).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1');
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, {}, 'Pipeline permanently deleted.');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('emits an attributed pipeline.purge audit event after a successful purge', async () => {
    mockFindDeletedById.mockResolvedValue(existingPipeline);
    mockPurgeById.mockResolvedValue('pipeline-uuid-1');

    await handler(mockReq(), mockRes());

    expect(mockEmitPipelineAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitPipelineAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pipeline.purge',
        actorId: 'user-1',
        orgId: 'org-1',
        affectedOrgId: 'org-1', // existing.orgId
        targetType: 'pipeline',
        targetId: 'pipeline-uuid-1',
        details: expect.objectContaining({
          pipelineName: 'test',
          accessModifier: 'private',
        }),
      }),
    );
  });

  it('attributes affectedOrgId to the tombstone org (not the caller org)', async () => {
    mockFindDeletedById.mockResolvedValue({ ...existingPipeline, orgId: 'target-org' });
    mockPurgeById.mockResolvedValue('pipeline-uuid-1');

    await handler(mockReq(), mockRes());

    expect(mockEmitPipelineAudit).toHaveBeenCalledWith(
      expect.objectContaining({ affectedOrgId: 'target-org' }),
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
    expect(mockFindDeletedById).not.toHaveBeenCalled();
    expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when the tombstone does not exist (findDeletedById returns null)', async () => {
    mockFindDeletedById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindDeletedById).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1');
    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Pipeline');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockPurgeById).not.toHaveBeenCalled();
    expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when purgeById returns null (already purged / matched no rows)', async () => {
    mockFindDeletedById.mockResolvedValue(existingPipeline);
    mockPurgeById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockPurgeById).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1');
    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Pipeline');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
  });

  it('returns 403 (publish gate) when a non-publisher purges a PUBLIC tombstone', async () => {
    mockFindDeletedById.mockResolvedValue({ ...existingPipeline, accessModifier: 'public' });
    requirePublicAccess.mockReturnValueOnce(false);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(requirePublicAccess).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ accessModifier: 'public' }),
      'pipelines:publish',
    );
    // requirePublicAccess itself owns the 403 response; the route purges nothing.
    expect(mockPurgeById).not.toHaveBeenCalled();
    expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
  });

  it('returns 500 on service error', async () => {
    mockFindDeletedById.mockRejectedValue(new Error('DB failure'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
  });
});
