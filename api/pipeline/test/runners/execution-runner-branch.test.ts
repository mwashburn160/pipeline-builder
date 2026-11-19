// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The execution routes' runner branch, the plugin-upgrade redeploy through it
 * (G6), the registry read's `runner` field — and, with the feature OFF, that
 * nothing about runners is touched: the runner store module throws on any use.
 */

import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { routeHandler, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from '../helpers/mock-api-core.js';

const mockSend = jest.fn<(cmd: unknown) => Promise<unknown>>();
class StartPipelineExecutionCommand { constructor(public input: unknown) {} }
class StopPipelineExecutionCommand { constructor(public input: unknown) {} }
jest.unstable_mockModule('@aws-sdk/client-codepipeline', () => ({
  CodePipelineClient: class { send = mockSend; },
  StartPipelineExecutionCommand,
  StopPipelineExecutionCommand,
}));

// The Drizzle runner store: ANY use fails the test (feature-off isolation).
const storeTouched = jest.fn();
jest.unstable_mockModule('../../src/runners/store.js', () => ({
  createDrizzleRunnerStore: () => new Proxy({}, { get: (_t, p) => () => { storeTouched(String(p)); throw new Error(`runner table touched: ${String(p)}`); } }),
}));

const mockFindByPipelineId = jest.fn<AnyFn>();
const mockRegistryList = jest.fn<AnyFn>();
jest.unstable_mockModule('../../src/services/pipeline-registry-service.js', () => ({
  pipelineRegistryService: { findByPipelineId: mockFindByPipelineId, list: mockRegistryList },
  PR_PIPELINE_NOT_OWNED: 'PR_PIPELINE_NOT_OWNED',
  PR_REGISTRY_OWNED_BY_OTHER_ORG: 'PR_REGISTRY_OWNED_BY_OTHER_ORG',
}));
const mockPipelineFindById = jest.fn<AnyFn>();
jest.unstable_mockModule('../../src/services/pipeline-service.js', () => ({ pipelineService: { findById: mockPipelineFindById } }));
jest.unstable_mockModule('../../src/services/execution-idempotency.js', () => ({
  executionIdempotency: { claim: async () => ({ token: 't' }), release: async () => undefined },
}));

const mockAudit = jest.fn<AnyFn>();
const sendSuccess = jest.fn<AnyFn>();
const sendError = jest.fn<AnyFn>();
const sendPaginatedNested = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockAudit,
  sendSuccess,
  sendError,
  sendPaginatedNested,
  sendBadRequest: jest.fn<AnyFn>(),
  getParam: (p: Record<string, string>, k: string) => p[k],
  validateBody: (req: { body?: unknown }, schema: { safeParse: (b: unknown) => { success: boolean; data?: unknown } }) => {
    const r = schema.safeParse(req.body ?? {});
    return r.success ? { ok: true, value: r.data } : { ok: false, error: 'bad' };
  },
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  setGauge: () => undefined,
  createAuthenticatedWithOrgRoute: () => [],
  withRoute: (h: AnyFn) => async (req: unknown, res: unknown) => h({ req, res, ctx: { log: () => undefined }, orgId: '0123456789abcdef01234567', userId: 'user-1' }),
}));

const { createExecutionRoutes } = await import('../../src/routes/executions.js');
const { createRegistryRoutes } = await import('../../src/routes/registry.js');
const { triggerExecutionInWindow } = await import('../../src/helpers/trigger-execution.js');
const { setRunnerDepsForTesting } = await import('../../src/runners/deps.js');
const { ORG, PIPE, reply, runnerRow, testDeps } = await import('../helpers/runner-fakes.js');

const res = () => ({ status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>(), setHeader: jest.fn<AnyFn>() });
const exec = createExecutionRoutes();
const trigger = routeHandler(exec, 'post', '/:pipelineId/executions');
const stop = routeHandler(exec, 'post', '/:pipelineId/executions/:executionId/stop');
const notFound = () => Object.assign(new Error('nf'), { name: 'PipelineNotFoundException' });

beforeEach(() => {
  jest.clearAllMocks();
  mockFindByPipelineId.mockResolvedValue({ pipelineName: 'acme-pipe', region: 'us-east-1' });
  mockPipelineFindById.mockResolvedValue({ id: PIPE });
});
afterEach(() => { setRunnerDepsForTesting(null); });

describe('no runner signing key (default): today\'s behaviour, no runner table touched', () => {
  it('start, stop, the plugin-upgrade trigger and the registry read never load the runner store', async () => {
    delete process.env.RUNNER_SIGNING_KEY;
    delete process.env.RUNNER_SIGNING_KEY_FILE;
    setRunnerDepsForTesting(null);
    mockSend.mockResolvedValue({ pipelineExecutionId: 'exec-1' });
    await trigger({ params: { pipelineId: PIPE }, user: {} }, res());
    expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 202, { executionId: 'exec-1' });
    mockSend.mockResolvedValue({});
    await stop({ params: { pipelineId: PIPE, executionId: 'exec-1' }, body: {}, user: {} }, res());
    expect(sendSuccess).toHaveBeenLastCalledWith(expect.anything(), 200, { stopped: true });
    mockSend.mockRejectedValue(notFound());
    await trigger({ params: { pipelineId: PIPE }, user: {} }, res());
    expect(sendError).toHaveBeenLastCalledWith(expect.anything(), 404, 'Pipeline not found in AWS', expect.anything());
    mockSend.mockResolvedValue({ pipelineExecutionId: 'exec-2' });
    expect(await triggerExecutionInWindow(PIPE, ORG, { requestedBy: 'system:plugin-upgrade' })).toEqual({ status: 'started', executionId: 'exec-2' });
    mockRegistryList.mockResolvedValue({ rows: [{ id: 'r1', pipelineId: PIPE }], total: 1 });
    await routeHandler(createRegistryRoutes(), 'get', '/registry')({ query: {}, user: {} }, res());
    expect(sendPaginatedNested).toHaveBeenCalledWith(expect.anything(), 'registry', [{ id: 'r1', pipelineId: PIPE, runner: null }], expect.anything());
    expect(storeTouched).not.toHaveBeenCalled();
  });
});

const FEAT = { features: ['cross_account_runners'] };

describe('feature ON', () => {
  function on() {
    const deps = testDeps();
    setRunnerDepsForTesting(deps);
    const r = runnerRow({ label: 'prod-account' });
    deps.store.runners.set(r.id, r);
    return { deps, r };
  }

  it('a linked pipeline\'s start → 202 { requestId, status: "queued", runnerLabel }, audited with requestId/runnerId/attempts/outcome', async () => {
    const { deps, r } = on();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'acme-pipe', region: 'us-east-1', runnerId: r.id });
    await trigger({ params: { pipelineId: PIPE }, user: FEAT }, res());
    const [, status, data] = sendSuccess.mock.calls[0]!;
    expect(status).toBe(202);
    expect(data).toEqual({ requestId: expect.any(String), status: 'queued', runnerLabel: 'prod-account' });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline.execution.start', details: { pipelineId: PIPE, requestId: (data as { requestId: string }).requestId, runnerId: r.id, attempts: 0, outcome: 'queued' } }));
  });

  it('a Re-run while a start is still pending → the same request, audited as REUSED (not a second "queued")', async () => {
    const { deps, r } = on();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'acme-pipe', region: 'us-east-1', runnerId: r.id });
    await trigger({ params: { pipelineId: PIPE }, user: FEAT }, res());
    const first = (sendSuccess.mock.calls[0]![2] as { requestId: string }).requestId;
    await trigger({ params: { pipelineId: PIPE }, user: FEAT }, res());
    expect(sendSuccess).toHaveBeenLastCalledWith(expect.anything(), 202, { requestId: first, status: 'queued', runnerLabel: 'prod-account' });
    expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'pipeline.execution.start',
      details: { pipelineId: PIPE, reusedRequestId: first, runnerId: r.id, outcome: 'reused' },
    }));
    expect([...deps.store.requests.values()].filter((q) => q.action === 'start')).toHaveLength(1);
  });

  it('a database without the runner tables: the registry read carries runner: null and never asks for links', async () => {
    const { deps } = on();
    deps.store.tablesPresent = async () => false;
    deps.store.runnerLinks = async () => { throw new Error('relation "pipeline_runners" does not exist'); };
    mockRegistryList.mockResolvedValue({ rows: [{ id: 'r1', pipelineId: PIPE }], total: 1 });
    await routeHandler(createRegistryRoutes(), 'get', '/registry')({ query: {}, user: FEAT }, res());
    expect(sendPaginatedNested).toHaveBeenCalledWith(expect.anything(), 'registry', [{ id: 'r1', pipelineId: PIPE, runner: null }], expect.anything());
  });

  it('a stop through a runner → 202 queued (cancel audited); unlinked → today\'s 200', async () => {
    const { deps, r } = on();
    mockSend.mockResolvedValue({});
    await stop({ params: { pipelineId: PIPE, executionId: 'exec-1' }, body: {}, user: FEAT }, res());
    expect(sendSuccess).toHaveBeenLastCalledWith(expect.anything(), 200, { stopped: true });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    await stop({ params: { pipelineId: PIPE, executionId: 'exec-1' }, body: {}, user: FEAT }, res());
    expect(sendSuccess).toHaveBeenLastCalledWith(expect.anything(), 202, { requestId: expect.any(String), status: 'queued', runnerLabel: 'prod-account' });
    expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'pipeline.execution.cancel', targetId: 'exec-1', details: expect.objectContaining({ outcome: 'queued' }) }));
  });

  it('a runner refusal is the error envelope code + details (and a failure audit)', async () => {
    const { deps } = on();
    deps.store.runners.clear();
    mockSend.mockRejectedValue(notFound());
    await trigger({ params: { pipelineId: PIPE }, user: FEAT }, res());
    expect(sendError).toHaveBeenCalledWith(expect.anything(), 409, expect.any(String), 'NO_RUNNER', undefined);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', details: { pipelineId: PIPE, reason: 'no_runner', outcome: 'refused' } }));
    await stop({ params: { pipelineId: PIPE, executionId: 'e' }, body: {}, user: FEAT }, res());
    expect(sendError).toHaveBeenLastCalledWith(expect.anything(), 409, expect.any(String), 'NO_RUNNER', undefined);
  });

  it('G6: the plugin-upgrade redeploy routes through runner routing as system:plugin-upgrade', async () => {
    const { deps, r } = on();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    const out = await triggerExecutionInWindow(PIPE, ORG, { requestedBy: 'system:plugin-upgrade', orgHasFeature: true });
    expect(out).toMatchObject({ status: 'queued', requestStatus: 'queued', runnerId: r.id, runnerLabel: 'prod-account' });
    const row = deps.store.requests.get((out as { requestId: string }).requestId)!;
    expect(row).toMatchObject({ requestedBy: 'system:plugin-upgrade', action: 'start' });
    // …and the dispatcher's terminal audit attributes it to the system with the reason.
    const { processDelivery } = await import('../../src/runners/lifecycle.js');
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'started', executionId: 'e-9' }));
    await processDelivery(deps, row.id);
    expect(deps.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.execution.start', actorId: 'system', details: expect.objectContaining({ reason: 'plugin-upgrade', outcome: 'started' }) }));
  });

  it('the registry read carries runner: { id, label } for linked rows, null otherwise', async () => {
    const { deps, r } = on();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mockRegistryList.mockResolvedValue({ rows: [{ id: 'r1', pipelineId: PIPE }, { id: 'r2', pipelineId: other }], total: 2 });
    await routeHandler(createRegistryRoutes(), 'get', '/registry')({ query: {}, user: FEAT }, res());
    expect(sendPaginatedNested).toHaveBeenCalledWith(expect.anything(), 'registry', [
      { id: 'r1', pipelineId: PIPE, runner: { id: r.id, label: 'prod-account' } },
      { id: 'r2', pipelineId: other, runner: null },
    ], expect.anything());
  });
});

describe('per-org enablement: signing key configured, org WITHOUT cross_account_runners', () => {
  function keyed() {
    const deps = testDeps();
    // Any runner-table read would be visible here; only the registry link may be read.
    const reads: string[] = [];
    for (const k of ['getRunner', 'listRunners', 'insertRequest', 'runnerLinks', 'countPending'] as const) {
      const orig = deps.store[k] as (...a: unknown[]) => unknown;
      (deps.store as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { reads.push(k); return orig(...a); };
    }
    setRunnerDepsForTesting(deps);
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    return { deps, r, reads };
  }

  it('an unlinked pipeline: today\'s platform start (no discovery even when AWS says not found), registry runner null', async () => {
    const { deps, reads } = keyed();
    mockSend.mockResolvedValue({ pipelineExecutionId: 'exec-1' });
    await trigger({ params: { pipelineId: PIPE }, user: {} }, res());
    expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 202, { executionId: 'exec-1' });
    mockSend.mockRejectedValue(notFound());
    await trigger({ params: { pipelineId: PIPE }, user: {} }, res());
    expect(sendError).toHaveBeenLastCalledWith(expect.anything(), 404, 'Pipeline not found in AWS', expect.anything());
    expect(deps.fetchMock).not.toHaveBeenCalled();
    mockRegistryList.mockResolvedValue({ rows: [{ id: 'r1', pipelineId: PIPE }], total: 1 });
    await routeHandler(createRegistryRoutes(), 'get', '/registry')({ query: {}, user: {} }, res());
    expect(sendPaginatedNested).toHaveBeenLastCalledWith(expect.anything(), 'registry', [{ id: 'r1', pipelineId: PIPE, runner: null }], expect.anything());
    expect(reads).toEqual([]);
    expect(deps.orgFeature.get(ORG)).toBe(false);
  });

  it('a pipeline still LINKED to a runner (the org lost the feature) → 409 RUNNERS_NOT_ENABLED, never the platform', async () => {
    const { deps, r } = keyed();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    await trigger({ params: { pipelineId: PIPE }, user: {} }, res());
    expect(sendError).toHaveBeenLastCalledWith(expect.anything(), 409, expect.any(String), 'RUNNERS_NOT_ENABLED', undefined);
    await stop({ params: { pipelineId: PIPE, executionId: 'e' }, body: {}, user: {} }, res());
    expect(sendError).toHaveBeenLastCalledWith(expect.anything(), 409, expect.any(String), 'RUNNERS_NOT_ENABLED', undefined);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the dispatcher re-checks per job: a queued request of an org that lost the feature fails RUNNERS_NOT_ENABLED undelivered', async () => {
    const { deps, r } = keyed();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    await trigger({ params: { pipelineId: PIPE }, user: FEAT }, res());
    const id = (sendSuccess.mock.calls[0]![2] as { requestId: string }).requestId;
    await trigger({ params: { pipelineId: PIPE }, user: {} }, res()); // a member's token without it
    const { processDelivery } = await import('../../src/runners/lifecycle.js');
    await processDelivery(deps, id);
    expect(deps.store.requests.get(id)).toMatchObject({ status: 'failed', errorCode: 'RUNNERS_NOT_ENABLED' });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('a superadmin holds every feature (as requireFeature rules)', async () => {
    const { deps, r } = keyed();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    await trigger({ params: { pipelineId: PIPE }, user: { isSuperAdmin: true } }, res());
    expect(sendSuccess).toHaveBeenLastCalledWith(expect.anything(), 202, expect.objectContaining({ status: 'queued' }));
  });
});
