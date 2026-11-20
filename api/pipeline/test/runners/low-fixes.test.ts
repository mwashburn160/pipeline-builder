// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the low-severity review items (health race, the
 * pending-start race, admin-ping version bookkeeping, pre-runner databases)
 * — each failed before its fix.
 */

import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';

const mockFindById = jest.fn<(id: string, orgId: string) => Promise<unknown>>();
jest.unstable_mockModule('../../src/services/pipeline-service.js', () => ({ pipelineService: { findById: mockFindById } }));

const { recordRunnerFailure } = await import('../../src/runners/lifecycle.js');
const { enqueueRun } = await import('../../src/runners/routing.js');
const { registerRunner, updateRunner } = await import('../../src/runners/admin.js');
const { routeExecution } = await import('../../src/runners/execution-routing.js');
const { ORG, PIPE, reply, runnerRow, testDeps, URL_A } = await import('../helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
const URL_B = 'https://def456.lambda-url.us-east-1.on.aws/';
function add(deps: Deps, over: Parameters<typeof runnerRow>[0] = {}) {
  const r = runnerRow(over); deps.store.runners.set(r.id, r); return r;
}
const input = (over: Record<string, unknown> = {}) => ({ pipelineId: PIPE, orgId: ORG, requestedBy: 'user-1', action: 'start' as const, ...over });

const ENV = { ...process.env };
beforeEach(() => { mockFindById.mockReset(); mockFindById.mockResolvedValue({ id: PIPE }); });
afterEach(() => { process.env = { ...ENV }; });

describe('1. the unreachable transition is taken once', () => {
  it('two concurrent threshold-crossing failures → one notice, one health audit', async () => {
    const deps = testDeps();
    const r = add(deps, { consecutiveFailures: 2 });
    await Promise.all([recordRunnerFailure(deps, r), recordRunnerFailure(deps, r)]);
    expect(deps.store.runners.get(r.id)!.health).toBe('unreachable');
    expect(deps.notified).toHaveLength(1);
    expect(deps.audits.filter((a) => a.action === 'pipeline.runner.health')).toHaveLength(1);
  });
});

describe('2. one pending start per pipeline (the unique index)', () => {
  it('a 23505 on insert (a concurrent Re-run won) returns the winner\'s request as reused', async () => {
    const deps = testDeps();
    const r = add(deps);
    const winner = await deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u2', requestedAt: new Date(deps.clock.t), expiresAt: new Date(deps.clock.t + 600_000), runnerId: r.id });
    // The race: our findPendingStart ran before the winner's row existed.
    const find = deps.store.findPendingStart;
    let calls = 0;
    deps.store.findPendingStart = async (o, p) => (calls++ === 0 ? null : find(o, p));
    deps.store.insertRequest = async () => { throw Object.assign(new Error('duplicate key'), { cause: { code: '23505' } }); };
    const out = await enqueueRun(deps, r, input());
    expect(out).toMatchObject({ requestId: winner.id, status: 'queued', runnerId: r.id, reused: true });
  });

  it('a fresh request is not marked reused; a found pending start is', async () => {
    const deps = testDeps();
    const r = add(deps);
    const first = await enqueueRun(deps, r, input());
    expect(first.reused).toBe(false);
    expect(await enqueueRun(deps, r, input())).toMatchObject({ requestId: first.requestId, reused: true });
  });
});

describe('5. admin pings keep the MIN_RUNNER_VERSION bookkeeping', () => {
  it('a register / URL change that reports an old version starts the grace clock; a current one clears it', async () => {
    process.env.MIN_RUNNER_VERSION = '2.0.0';
    const deps = testDeps();
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'pong', runnerVersion: '1.0.0' }));
    const reg = await registerRunner(deps, ORG, 'u', { label: 'a', functionUrl: URL_A });
    expect(reg.updateRequiredSince).toEqual(new Date(deps.clock.t));
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'pong', runnerVersion: '2.1.0' }));
    const { runner } = await updateRunner(deps, ORG, 'u', reg.id, { functionUrl: URL_B });
    expect(runner).toMatchObject({ version: '2.1.0', updateRequiredSince: null });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'pong', runnerVersion: '1.5.0' }));
    const again = await updateRunner(deps, ORG, 'u', reg.id, { functionUrl: URL_A });
    expect(again.runner.updateRequiredSince).toEqual(new Date(deps.clock.t));
    expect(deps.notified).toHaveLength(2); // once per transition below the minimum
  });
});

describe('7. a database without the runner tables', () => {
  it('execution routing answers 409 RUNNERS_UNAVAILABLE (no 500, no runner asked)', async () => {
    const deps = testDeps();
    add(deps);
    deps.availability.available = false;
    deps.availability.reason = 'tables_missing';
    deps.store.getRegistryLink = async () => { throw new Error('relation "pipeline_runners" does not exist'); };
    await expect(routeExecution(input(), deps)).rejects.toMatchObject({ status: 409, code: 'RUNNERS_UNAVAILABLE' });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });
});
