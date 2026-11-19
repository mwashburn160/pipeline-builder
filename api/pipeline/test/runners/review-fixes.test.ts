// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for defects found in review of the runner dispatcher, the
 * run-request status read and the sweep — each one failed before its fix.
 */

import { jest, describe, expect, it, beforeEach } from '@jest/globals';

const mockFindById = jest.fn<(id: string, orgId: string) => Promise<unknown>>();
jest.unstable_mockModule('../../src/services/pipeline-service.js', () => ({ pipelineService: { findById: mockFindById } }));

const { processDelivery, runSweep } = await import('../../src/runners/lifecycle.js');
const { enqueueRun } = await import('../../src/runners/routing.js');
const { bullDispatchQueue } = await import('../../src/runners/dispatch-queue.js');
const { readRunRequest, resetRunRequestCachesForTesting } = await import('../../src/runners/run-request-status.js');
const { claimsOf, ORG, PIPE, reply, runnerRow, testDeps } = await import('../helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
function add(deps: Deps, over: Parameters<typeof runnerRow>[0] = {}) {
  const r = runnerRow(over); deps.store.runners.set(r.id, r); return r;
}
async function queued(deps: Deps, runnerId: string, over: Record<string, unknown> = {}) {
  return deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'user-1', requestedAt: new Date(deps.clock.t), expiresAt: new Date(deps.clock.t + 600_000), runnerId, ...over });
}

beforeEach(() => {
  mockFindById.mockReset(); mockFindById.mockResolvedValue({ id: PIPE });
  resetRunRequestCachesForTesting();
});

describe('re-discovery keeps the dispatch job', () => {
  it('a re-targeted request is retried by the SAME job (BullMQ ignores re-adding the active job id)', async () => {
    const deps = testDeps();
    const old = add(deps, { label: 'old' });
    const moved = add(deps, { label: 'moved' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: old.id });
    const q = await queued(deps, old.id);
    deps.fetchMock.mockImplementation(async (_u, o) => {
      const c = claimsOf(String(o.body));
      if (c.aud === old.id) return reply(404, { errorCode: 'PIPELINE_NOT_FOUND' });
      return reply(200, { outcome: c.action === 'probe' ? 'match' : 'started', executionId: 'e-2' });
    });
    // `done: true` would complete the active job; the re-add of its own id is a
    // BullMQ no-op, so the request would sit queued until the next sweep.
    expect(await processDelivery(deps, q.id)).toEqual({ done: false, retryInMs: 0 });
    expect(deps.store.requests.get(q.id)).toMatchObject({ status: 'queued', runnerId: moved.id });
  });
});

describe('a revoked runner', () => {
  it('fails its queued request with RUNNER_REVOKED (the code revoke itself records), not RUN_REQUEST_EXPIRED', async () => {
    const deps = testDeps();
    const r = add(deps, { status: 'revoked' });
    const q = await queued(deps, r.id);
    await processDelivery(deps, q.id);
    expect(deps.store.requests.get(q.id)).toMatchObject({ status: 'expired', errorCode: 'RUNNER_REVOKED' });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });
});

describe('run-request status refresh', () => {
  it('never calls an UNREACHABLE runner (a poll would wait out the delivery timeout)', async () => {
    const deps = testDeps();
    const r = add(deps, { health: 'unreachable' });
    const q = await queued(deps, r.id, { status: 'started', resultExecutionId: 'exec-1' });
    const dto = await readRunRequest(deps, ORG, PIPE, q.id);
    expect(dto).toMatchObject({ status: 'started', executionId: 'exec-1', executionStatus: null });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('stops asking once the execution reached a final state', async () => {
    const deps = testDeps();
    const r = add(deps);
    const q = await queued(deps, r.id, { status: 'started', resultExecutionId: 'exec-1' });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'status', executionId: 'exec-1', executionStatus: 'Succeeded' }));
    expect((await readRunRequest(deps, ORG, PIPE, q.id))!.executionStatus).toBe('Succeeded');
    deps.clock.t += 60_000;
    expect((await readRunRequest(deps, ORG, PIPE, q.id))!.executionStatus).toBe('Succeeded');
    expect(deps.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('status refresh when the runner no longer finds the pipeline', () => {
  it('a 404 PIPELINE_NOT_FOUND leaves the started request, its link and its execution id alone; the status is just unknown', async () => {
    const deps = testDeps();
    const r = add(deps);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: 'us-east-1', runnerId: r.id });
    const q = await queued(deps, r.id, { status: 'started', resultExecutionId: 'exec-1' });
    deps.fetchMock.mockResolvedValue(reply(404, { errorCode: 'PIPELINE_NOT_FOUND', runnerVersion: '1.2.3' }));
    const dto = await readRunRequest(deps, ORG, PIPE, q.id);
    expect(dto).toMatchObject({ status: 'started', executionId: 'exec-1', executionStatus: null, errorCode: null });
    expect(deps.store.requests.get(q.id)).toMatchObject({ status: 'started', resultExecutionId: 'exec-1' });
    // A read never re-routes: the next start/stop through the link runs G4 re-discovery.
    expect(deps.store.registry.get(PIPE)!.runnerId).toBe(r.id);
    expect(deps.store.runners.get(r.id)!.health).toBe('healthy');
  });
});

describe('the sweep on a database created before runners', () => {
  it('skips quietly when the runner tables are absent (no error every 15 s)', async () => {
    const deps = testDeps();
    const missing = () => Promise.reject(new Error('relation "pipeline_run_requests" does not exist'));
    Object.assign(deps.store, { tablesPresent: async () => false, listExpired: missing, deletePendingRunnersBefore: missing });
    await expect(runSweep(deps)).resolves.toEqual({ expired: 0, pinged: 0, recovered: 0, rekicked: 0, pendingDeleted: 0, retained: 0 });
  });
});

describe('enqueue when Redis is unavailable', () => {
  it('a failed enqueue does not fail the run: the row stays queued for the sweep', async () => {
    const deps = testDeps({ queue: { enqueue: () => Promise.reject(new Error('Connection is closed')) } });
    const r = add(deps);
    const queuedRun = await enqueueRun(deps, r, { pipelineId: PIPE, orgId: ORG, requestedBy: 'user-1', action: 'start' });
    expect(queuedRun).toMatchObject({ status: 'queued', runnerId: r.id });
    expect(deps.store.requests.get(queuedRun.requestId)!.status).toBe('queued');
  });

  it('a BullMQ add that never settles (offline queue) is bounded', async () => {
    const hang = jest.fn(() => new Promise<never>(() => undefined));
    await expect(bullDispatchQueue({ add: hang } as never, 20).enqueue('req-1')).rejects.toThrow(/timed out/);
  }, 2_000);
});
