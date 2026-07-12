// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the AWS CodePipeline trigger / cancel write path:
 *   POST /pipelines/:pipelineId/executions
 *   POST /pipelines/:pipelineId/executions/:executionId/stop
 *
 * The real execution service + routes run; only the AWS SDK client and the
 * registry lookup are mocked. Auth/`pipelines:write` gating is applied at the
 * mount point (index.ts), not inside the router, so it isn't exercised here.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// -- AWS SDK mock: a single shared send() spy + command classes that capture
//    their input so we can assert the built request. --------------------------
const mockSend = jest.fn<(cmd: unknown) => Promise<unknown>>();

class MockCodePipelineClient {
  send = mockSend;
  constructor(public config: { region?: string }) {}
}
class StartPipelineExecutionCommand {
  constructor(public input: { name?: string }) {}
}
class StopPipelineExecutionCommand {
  constructor(public input: { pipelineName?: string; pipelineExecutionId?: string; reason?: string; abandon?: boolean }) {}
}

jest.unstable_mockModule('@aws-sdk/client-codepipeline', () => ({
  CodePipelineClient: MockCodePipelineClient,
  StartPipelineExecutionCommand,
  StopPipelineExecutionCommand,
}));

// -- Registry lookup mock: the org-scoped pipelineId → {name, region} resolve.
const mockFindByPipelineId = jest.fn<(pipelineId: string, orgId: string) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/pipeline-registry-service.js', () => ({
  pipelineRegistryService: { findByPipelineId: mockFindByPipelineId },
  PR_PIPELINE_NOT_OWNED: 'PR_PIPELINE_NOT_OWNED',
  PR_REGISTRY_OWNED_BY_OTHER_ORG: 'PR_REGISTRY_OWNED_BY_OTHER_ORG',
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn(),
  sendBadRequest: jest.fn(),
  sendError: jest.fn(),
  getParam: (p: any, k: string) => p[k],
  validateBody: (req: any, schema: any) => {
    const result = schema.safeParse(req.body ?? {});
    return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message };
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme', userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

const { sendSuccess, sendError } = await import('@pipeline-builder/api-core');
const { createExecutionRoutes } = await import('../src/routes/executions.js');

/** Build an AWS-style error whose `.name` drives the service's classification. */
function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

describe('pipeline execution write routes', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createExecutionRoutes();
    mockFindByPipelineId.mockResolvedValue({ pipelineName: 'acme-pipe', region: 'us-east-1' });
  });

  function handlerFor(path: string) {
    return router.stack.find(
      (l: any) => l.route?.path === path && l.route?.methods?.post,
    )?.route?.stack[0]?.handle;
  }

  const triggerHandler = () => handlerFor('/:pipelineId/executions');
  const stopHandler = () => handlerFor('/:pipelineId/executions/:executionId/stop');

  it('registers both POST write routes', () => {
    expect(triggerHandler()).toBeDefined();
    expect(stopHandler()).toBeDefined();
  });

  // -- trigger --------------------------------------------------------------

  it('trigger: happy path returns 202 with the new executionId and builds the command with the registry name', async () => {
    mockSend.mockResolvedValue({ pipelineExecutionId: 'exec-123' });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await triggerHandler()({ params: { pipelineId: 'p-1' } }, res);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0] as StartPipelineExecutionCommand;
    expect(cmd).toBeInstanceOf(StartPipelineExecutionCommand);
    expect(cmd.input.name).toBe('acme-pipe');
    expect(sendSuccess).toHaveBeenCalledWith(res, 202, { executionId: 'exec-123' });
  });

  it('trigger: unregistered / wrong-org pipeline → 404 and no AWS call', async () => {
    mockFindByPipelineId.mockResolvedValue(null);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await triggerHandler()({ params: { pipelineId: 'p-other' } }, res);

    expect(mockSend).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(res, 404, expect.stringMatching(/not deployed\/registered/), expect.any(String));
  });

  it('trigger: AWS PipelineNotFoundException (stale registry) → 404', async () => {
    mockSend.mockRejectedValue(awsError('PipelineNotFoundException'));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await triggerHandler()({ params: { pipelineId: 'p-1' } }, res);

    expect(sendError).toHaveBeenCalledWith(res, 404, expect.stringMatching(/not found in AWS/), expect.any(String));
  });

  it('trigger: generic AWS error → 502 with sanitized detail only', async () => {
    mockSend.mockRejectedValue(awsError('ThrottlingException', 'Rate exceeded'));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await triggerHandler()({ params: { pipelineId: 'p-1' } }, res);

    expect(sendError).toHaveBeenCalledWith(
      res, 502, 'Upstream AWS error', expect.any(String),
      { awsName: 'ThrottlingException', awsMessage: 'Rate exceeded' },
    );
  });

  it('trigger: missing pipelineId → 400', async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const { sendBadRequest } = await import('@pipeline-builder/api-core');
    await triggerHandler()({ params: {} }, res);
    expect(sendBadRequest).toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  // -- stop -----------------------------------------------------------------

  it('stop: happy path returns 200 and builds the stop command with name + executionId + reason', async () => {
    mockSend.mockResolvedValue({});
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await stopHandler()({ params: { pipelineId: 'p-1', executionId: 'exec-9' }, body: { reason: 'stop it' } }, res);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0] as StopPipelineExecutionCommand;
    expect(cmd).toBeInstanceOf(StopPipelineExecutionCommand);
    expect(cmd.input.pipelineName).toBe('acme-pipe');
    expect(cmd.input.pipelineExecutionId).toBe('exec-9');
    expect(cmd.input.reason).toBe('stop it');
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, { stopped: true });
  });

  it('stop: PipelineExecutionNotStoppableException → 409', async () => {
    mockSend.mockRejectedValue(awsError('PipelineExecutionNotStoppableException'));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await stopHandler()({ params: { pipelineId: 'p-1', executionId: 'exec-9' }, body: {} }, res);

    expect(sendError).toHaveBeenCalledWith(res, 409, expect.stringMatching(/stoppable/), expect.any(String));
  });

  it('stop: unregistered / wrong-org pipeline → 404 and no AWS call', async () => {
    mockFindByPipelineId.mockResolvedValue(null);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await stopHandler()({ params: { pipelineId: 'p-other', executionId: 'exec-9' }, body: {} }, res);

    expect(mockSend).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(res, 404, expect.stringMatching(/not deployed\/registered/), expect.any(String));
  });
});
