// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The execution write routes, runners being the only execution path:
 *   POST /pipelines/:pipelineId/executions
 *   POST /pipelines/:pipelineId/executions/:executionId/stop
 *
 * The real routes, windowed trigger, routing and discovery run over the
 * in-memory runner doubles; only the pipeline visibility lookup, the
 * idempotency window and the HTTP helpers are stubbed. Both routes answer
 * a queued run request (QueuedRunRequestDto) and nothing else.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockEmitPipelineAudit = jest.fn<AnyFn>();
const mockPipelineFindById = jest.fn<(id: string, orgId?: string) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: { findById: mockPipelineFindById },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitPipelineAudit,
  sendSuccess: jest.fn<AnyFn>(),
  sendBadRequest: jest.fn<AnyFn>(),
  sendError: jest.fn<AnyFn>(),
  getParam: (p: any, k: string) => p[k],
  validateBody: (req: any, schema: any) => {
    const result = schema.safeParse(req.body ?? {});
    return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message };
  },
}));

const mockClaim = jest.fn<(orgId: string, pipelineId: string) => Promise<{ token: string | null } | null>>();
const mockRelease = jest.fn<(orgId: string, pipelineId: string, claim: { token: string | null }) => Promise<void>>();
jest.unstable_mockModule('../src/services/execution-idempotency.js', () => ({
  executionIdempotency: { claim: mockClaim, release: mockRelease },
}));

const ORG_ID = '0123456789abcdef01234567';
const mockIncCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  createAuthenticatedWithOrgRoute: () => [],
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: ORG_ID, userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: ORG_ID, userId: 'user-1' });
  },
}));

const { sendSuccess, sendError, sendBadRequest } = await import('@pipeline-builder/api-core') as unknown as Record<string, jest.Mock<AnyFn>>;
const { createExecutionRoutes } = await import('../src/routes/executions.js');
const { setRunnerDepsForTesting } = await import('../src/runners/deps.js');
const { ORG, PIPE, reply, runnerRow, testDeps } = await import('./helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
const router = createExecutionRoutes() as any;
const handlerFor = (path: string) => {
  const stack = router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.post).route.stack;
  return stack[stack.length - 1].handle;
};
const start = (pipelineId = PIPE) => handlerFor('/:pipelineId/executions')({ params: { pipelineId }, user: {} }, {});
const stop = (pipelineId = PIPE, executionId = 'exec-7') => handlerFor('/:pipelineId/executions/:executionId/stop')({ params: { pipelineId, executionId }, body: {}, user: {} }, {});

let deps: Deps;
function addRunner(over: Parameters<typeof runnerRow>[0] = {}) {
  const r = runnerRow(over); deps.store.runners.set(r.id, r); return r;
}
const successBody = () => sendSuccess.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
const errorOf = () => {
  const call = sendError.mock.calls[0];
  return call ? { status: call[1], message: call[2], code: call[3], details: call[4] } : undefined;
};

beforeEach(() => {
  jest.clearAllMocks();
  expect(ORG).toBe(ORG_ID);
  mockClaim.mockResolvedValue({ token: 'tok-1' });
  mockRelease.mockResolvedValue(undefined);
  mockPipelineFindById.mockResolvedValue({ id: PIPE });
  deps = testDeps();
  setRunnerDepsForTesting(deps);
});
afterEach(() => { setRunnerDepsForTesting(null); });

describe('POST /:pipelineId/executions', () => {
  it('an org with no runner gets 409 NO_RUNNER on its first Run, pointing at Settings → Pipeline runners; the window reopens', async () => {
    await start();
    expect(errorOf()).toMatchObject({ status: 409, code: 'NO_RUNNER', message: expect.stringContaining('Settings → Pipeline runners') });
    expect(mockRelease).toHaveBeenCalledWith(ORG, PIPE, { token: 'tok-1' });
    expect(mockEmitPipelineAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', details: expect.objectContaining({ reason: 'no_runner', outcome: 'refused' }) }));
  });

  it('a linked runner: 202 with ONLY the queued run request (no executionId), audited as queued', async () => {
    const r = addRunner({ label: 'prod' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    await start();
    expect(sendSuccess).toHaveBeenCalledWith({}, 202, expect.anything());
    const body = successBody()!;
    expect(Object.keys(body).sort()).toEqual(['requestId', 'runnerLabel', 'status']);
    expect(body).toMatchObject({ status: 'queued', runnerLabel: 'prod' });
    expect(deps.store.requests.get(body.requestId as string)).toMatchObject({ action: 'start', runnerId: r.id, requestedBy: 'user-1' });
    expect(mockEmitPipelineAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline.execution.start', details: expect.objectContaining({ outcome: 'queued' }) }));
  });

  it('unlinked: straight to discovery (no platform step), links the single match and queues', async () => {
    const r = addRunner({ label: 'prod' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
    await start();
    expect(successBody()).toMatchObject({ status: 'queued', runnerLabel: 'prod' });
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: r.id, linkStatus: 'linked' });
  });

  it('a double click queues ONE run: the window refuses the second inside it, and a pending start is reused after it', async () => {
    const r = addRunner();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    mockClaim.mockResolvedValueOnce({ token: 'tok-1' }).mockResolvedValueOnce(null).mockResolvedValueOnce({ token: 'tok-3' });
    await start();
    await start();
    expect(errorOf()).toMatchObject({ status: 409, message: expect.stringMatching(/just triggered/) });
    await start();
    const ids = sendSuccess.mock.calls.map((c) => (c[2] as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect([...deps.store.requests.values()].filter((q) => q.action === 'start')).toHaveLength(1);
  });

  it('a malformed id is 400 (no lookup, no runner asked)', async () => {
    await start('nope');
    expect(errorOf()).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(mockPipelineFindById).not.toHaveBeenCalled();
  });

  it('a pipeline the caller cannot see is 404 and asks no runner', async () => {
    addRunner();
    mockPipelineFindById.mockResolvedValue(null);
    await start();
    expect(errorOf()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('paused deliveries → 409 RUNNERS_UNAVAILABLE, nothing queued', async () => {
    addRunner();
    deps.availability.available = false;
    deps.availability.reason = 'paused';
    await start();
    expect(errorOf()).toMatchObject({ status: 409, code: 'RUNNERS_UNAVAILABLE' });
    expect(deps.store.requests.size).toBe(0);
  });

  it('a user start at the pending cap is 429 TOO_MANY_PENDING (MAX_PENDING_PER_ORG is configurable)', async () => {
    const saved = process.env.MAX_PENDING_PER_ORG;
    process.env.MAX_PENDING_PER_ORG = '1';
    try {
      const r = addRunner();
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
      await deps.store.insertRequest({ orgId: ORG, pipelineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', action: 'start', requestedBy: 'u', expiresAt: new Date(deps.clock.t + 600_000), runnerId: r.id });
      await start();
      expect(errorOf()).toMatchObject({ status: 429, code: 'TOO_MANY_PENDING' });
    } finally {
      if (saved === undefined) delete process.env.MAX_PENDING_PER_ORG; else process.env.MAX_PENDING_PER_ORG = saved;
    }
  });
});

describe('POST /:pipelineId/executions/:executionId/stop', () => {
  it('202 with ONLY the queued run request; the stop carries the execution id', async () => {
    const r = addRunner({ label: 'prod' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    await stop();
    const body = successBody()!;
    expect(sendSuccess).toHaveBeenCalledWith({}, 202, expect.anything());
    expect(Object.keys(body).sort()).toEqual(['requestId', 'runnerLabel', 'status']);
    expect(deps.store.requests.get(body.requestId as string)).toMatchObject({ action: 'stop', executionId: 'exec-7' });
    expect(mockIncCounter).toHaveBeenCalledWith('pipeline_executions_total', { outcome: 'stop_queued' });
  });

  it('no runner → 409 NO_RUNNER, counted as a failed stop', async () => {
    await stop();
    expect(errorOf()).toMatchObject({ status: 409, code: 'NO_RUNNER' });
    expect(mockIncCounter).toHaveBeenCalledWith('pipeline_executions_total', { outcome: 'stop_failed' });
  });

  it('an invalid body is 400', async () => {
    await handlerFor('/:pipelineId/executions/:executionId/stop')({ params: { pipelineId: PIPE, executionId: 'e' }, body: { abandon: 'yes' }, user: {} }, {});
    expect(sendBadRequest).toHaveBeenCalled();
  });
});
