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
 * delegates to the passed-in service singleton + the same `requireVisibilityWriteAccess`
 * / `sendEntityNotFound` / `sendBadRequest` spies the real helper uses. That lets
 * the suite exercise every branch the real helper takes (400 missing-id, 404
 * tombstone-miss, 403 publish-gate, 404 purge-race-miss, happy path) end-to-end
 * through the route.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule, handlerGetter } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks — must be defined before imports

const mockFindDeletedById = jest.fn<AnyFn>();
const mockPurgeById = jest.fn<AnyFn>();

// The exposure tally runs the purge and reports what its hooks closed.
const EXPOSURES_CLOSED = 4;
jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    findDeletedById: mockFindDeletedById,
    purgeById: mockPurgeById,
  },
  withClosedExposureTally: async (fn: () => Promise<unknown>) => ({ result: await fn(), exposuresClosed: EXPOSURES_CLOSED }),
}));

// The deployment signal a purge checks (null = never registered / deregistered).
const mockDeploymentOf = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('../src/services/pipeline-registry-service.js', () => ({
  pipelineRegistryService: { deploymentOf: mockDeploymentOf },
}));

// The undeploy a purge sends through the pipeline's linked, deploy-capable runner (change 5).
const mockPlanUndeploy = jest.fn<AnyFn>(async () => ({ kind: 'retained', reason: 'no_runner' }));
const mockStartUndeploy = jest.fn<AnyFn>(async () => 'undeploy-req-1');
jest.unstable_mockModule('../src/helpers/undeploy-on-purge.js', () => ({
  planUndeploy: mockPlanUndeploy,
  startUndeploy: mockStartUndeploy,
}));
// The pipeline's active deploy through a runner (null: none in flight).
const mockFindActiveDeploy = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('../src/runners/deps.js', () => ({ runnerDeps: () => ({ store: { findActiveDeploy: mockFindActiveDeploy } }) }));

const mockEmitPipelineAudit = jest.fn<AnyFn>();
const sendError = jest.fn((res: any, status: number, msg: string, code?: string, details?: unknown) => {
  res.status(status).json({ success: false, statusCode: status, message: msg, code, details });
});

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
const requireVisibilityWriteAccess = jest.fn((_req: any, _res: any, _resource: any, _perm?: string, ..._rest: unknown[]) => true);
const sendSuccess = jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
  const response: any = { success: true, statusCode };
  if (data !== undefined) response.data = data;
  if (message) response.message = message;
  res.status(statusCode).json(response);
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitPipelineAudit,
  sendError,
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  requireVisibilityWriteAccess,
  sendSuccess,
  sendBadRequest,
  sendEntityNotFound,
  // Faithful re-implementation of the shared purge skeleton (see file header).
  loadAndPurge: jest.fn(async (
    req: any,
    res: any,
    service: any,
    { orgId, userId, label, publishPermission }: { orgId: string; userId: string; label: string; publishPermission: string },
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
    if (!requireVisibilityWriteAccess(req, res, existing, userId, publishPermission)) return null;
    const purgedId = await service.purgeById(id, orgId);
    if (!purgedId) {
      sendEntityNotFound(res, label);
      return null;
    }
    return { existing, purgedId };
  }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
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
}));

const { createPurgePipelineRoutes } = await import('../src/routes/purge-pipeline.js');

// Helpers

const router = createPurgePipelineRoutes();

const getHandler = handlerGetter(router);

const existingPipeline = {
  id: 'pipeline-uuid-1',
  pipelineName: 'test',
  orgId: 'org-1',
  visibility: 'private',
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

describe('POST /pipelines/:id/purge (purge)', () => {
  const handler = getHandler('post', '/:id/purge');

  beforeEach(() => { jest.clearAllMocks(); });

  describe('a pipeline with a deploy through a runner in flight', () => {
    it('is refused with 409 DEPLOY_IN_PROGRESS even with ?force=true: its stack is being created (nothing purged)', async () => {
      mockFindDeletedById.mockResolvedValueOnce(existingPipeline);
      mockFindActiveDeploy.mockResolvedValueOnce({ id: 'deploy-req-1', status: 'deploying' });
      const res = mockRes();
      await handler(mockReq({ query: { force: 'true' } }), res);
      expect(mockFindActiveDeploy).toHaveBeenCalledWith('org-1', 'pipeline-uuid-1');
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'DEPLOY_IN_PROGRESS', details: { requestId: 'deploy-req-1' } });
      expect(mockPurgeById).not.toHaveBeenCalled();
      expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
    });
  });

  describe('a pipeline still registered as deployed', () => {
    const deployment = { registryId: 'reg-1', stackName: 'acme-stack', region: 'us-east-1' };

    it('is refused with 409 (nothing purged, nothing audited)', async () => {
      mockFindDeletedById.mockResolvedValueOnce(existingPipeline);
      mockDeploymentOf.mockResolvedValueOnce(deployment);
      const res = mockRes();
      await handler(mockReq(), res);
      expect(mockFindDeletedById).toHaveBeenCalledWith('pipeline-uuid-1', 'org-1');
      expect(mockDeploymentOf).toHaveBeenCalledWith('pipeline-uuid-1');
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0].message).toMatch(/acme-stack.*force=true/);
      expect(mockPurgeById).not.toHaveBeenCalled();
      expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
    });

    it('never reads (or reveals) the registration of an id outside the caller\'s scope: 404', async () => {
      mockFindDeletedById.mockResolvedValue(null);
      mockDeploymentOf.mockResolvedValue(deployment);
      const res = mockRes();
      await handler(mockReq(), res);
      expect(mockDeploymentOf).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/acme-stack/);
      mockDeploymentOf.mockReset();
      mockDeploymentOf.mockResolvedValue(null);
    });

    it('linked to a deploy-capable runner: purges WITHOUT force and sends the undeploy (the stack goes with it)', async () => {
      mockDeploymentOf.mockResolvedValueOnce({ ...deployment, pipelineName: 'acme-pipe', runnerId: 'runner-1' });
      mockPlanUndeploy.mockResolvedValueOnce({ kind: 'undeploy', runnerId: 'runner-1', runnerLabel: 'prod' });
      mockFindDeletedById.mockResolvedValue(existingPipeline);
      mockPurgeById.mockResolvedValue('pipeline-uuid-1');
      const res = mockRes();
      await handler(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockStartUndeploy).toHaveBeenCalledTimes(1);
      // Sent only AFTER the purge landed.
      expect(mockPurgeById.mock.invocationCallOrder[0]).toBeLessThan(mockStartUndeploy.mock.invocationCallOrder[0]!);
      expect(res.json.mock.calls[0][0].data).toEqual({ undeploy: { requestId: 'undeploy-req-1', runnerLabel: 'prod' }, stackRetained: null });
      expect(mockEmitPipelineAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'pipeline.purge',
        details: expect.objectContaining({ undeployRequestId: 'undeploy-req-1', deregistered: { registryId: 'reg-1', stackName: 'acme-stack' } }),
      }));
    });

    it('an undeploy that could not be queued: the purge stands and the stack is retained as undeploy_not_queued', async () => {
      mockDeploymentOf.mockResolvedValueOnce({ ...deployment, pipelineName: 'acme-pipe', runnerId: 'runner-1' });
      mockPlanUndeploy.mockResolvedValueOnce({ kind: 'undeploy', runnerId: 'runner-1', runnerLabel: 'prod' });
      mockStartUndeploy.mockRejectedValueOnce(new Error('db down'));
      mockFindDeletedById.mockResolvedValue(existingPipeline);
      mockPurgeById.mockResolvedValue('pipeline-uuid-1');
      const res = mockRes();
      await handler(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0].data).toEqual({ undeploy: null, stackRetained: { stackName: 'acme-stack', region: 'us-east-1', reason: 'undeploy_not_queued' } });
    });

    it('a runner without the capability: still 409 without force, naming why the stack would stay', async () => {
      mockFindDeletedById.mockResolvedValueOnce(existingPipeline);
      mockDeploymentOf.mockResolvedValueOnce({ ...deployment, runnerId: 'runner-1' });
      mockPlanUndeploy.mockResolvedValueOnce({ kind: 'retained', reason: 'runner_not_deploy_capable' });
      const res = mockRes();
      await handler(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0].details).toEqual(expect.objectContaining({ stackRetainedReason: 'runner_not_deploy_capable' }));
      expect(mockPurgeById).not.toHaveBeenCalled();
      expect(mockStartUndeploy).not.toHaveBeenCalled();
    });

    it('purges with ?force=true, and the audit records the forced deregistration', async () => {
      mockDeploymentOf.mockResolvedValueOnce(deployment);
      mockFindDeletedById.mockResolvedValue(existingPipeline);
      mockPurgeById.mockResolvedValue('pipeline-uuid-1');
      const res = mockRes();
      await handler(mockReq({ query: { force: 'true' } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockEmitPipelineAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'pipeline.purge',
        details: expect.objectContaining({ forced: true, deregistered: { registryId: 'reg-1', stackName: 'acme-stack' } }),
      }));
      // No capable runner: nothing is sent, and the answer says the stack stays.
      expect(mockStartUndeploy).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].data).toEqual({ undeploy: null, stackRetained: { stackName: 'acme-stack', region: 'us-east-1', reason: 'no_runner' } });
    });
  });

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
          visibility: 'private',
          exposuresClosed: EXPOSURES_CLOSED,
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
    mockFindDeletedById.mockResolvedValue({ ...existingPipeline, visibility: 'public' });
    requireVisibilityWriteAccess.mockReturnValueOnce(false);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(requireVisibilityWriteAccess).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ visibility: 'public' }),
      'user-1',
      'pipelines:publish',
    );
    // requireVisibilityWriteAccess itself owns the 403 response; the route purges nothing.
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
