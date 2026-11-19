// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the low-severity review items (health race, the
 * pending-start race, the feature cache, admin-ping version bookkeeping, the
 * feature write volume, pre-runner databases) — each failed before its fix.
 */

import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';

const mockFindById = jest.fn<(id: string, orgId: string) => Promise<unknown>>();
jest.unstable_mockModule('../../src/services/pipeline-service.js', () => ({ pipelineService: { findById: mockFindById } }));

const { recordRunnerFailure, runSweep } = await import('../../src/runners/lifecycle.js');
const { enqueueRun } = await import('../../src/runners/routing.js');
const { registerRunner, updateRunner } = await import('../../src/runners/admin.js');
const { orgFeatureCache } = await import('../../src/runners/deps.js');
const { routeExecution } = await import('../../src/runners/execution-routing.js');
const { ORG, PIPE, reply, runnerRow, testDeps, URL_A } = await import('../helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
const URL_B = 'https://def456.lambda-url.us-east-1.on.aws/';
const DAY = 24 * 60 * 60_000;
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
    const r = add(deps, { consecutiveFailures: 4 });
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

describe('4. the org feature cache resolves a miss', () => {
  it('a miss asks the real entitlement and caches it; only a failed lookup falls back to enabled', async () => {
    const resolve = jest.fn(async (orgId: string) => orgId === 'with');
    const cache = orgFeatureCache(null, 3600, resolve);
    expect(await cache.orgEnabled('without')).toBe(false);
    expect(await cache.orgEnabled('without')).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await cache.orgEnabled('with')).toBe(true);
    const failing = orgFeatureCache(null, 3600, async () => { throw new Error('platform down'); });
    expect(await failing.orgEnabled('x')).toBe(true);
  });

  it('the sweep does not ping an unreachable runner of an org whose (expired) entry lacks the feature', async () => {
    const deps = testDeps();
    Object.assign(deps, orgFeatureCache(null, 3600, async () => false));
    const r = add(deps, { health: 'unreachable', updatedAt: new Date(deps.clock.t - DAY) });
    expect((await runSweep(deps)).pinged).toBe(0);
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(deps.store.runners.get(r.id)!.health).toBe('unreachable');
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

describe('6. noteOrgFeature writes only on a change (or a stale entry)', () => {
  it('repeating the same value does not rewrite Redis within a minute', async () => {
    const set = jest.fn(async () => 'OK' as string | null);
    let t = 0;
    const cache = orgFeatureCache({ set, get: async () => null }, 3600, undefined, () => t);
    await cache.noteOrgFeature(ORG, false);
    await cache.noteOrgFeature(ORG, false);
    expect(set).toHaveBeenCalledTimes(1);
    await cache.noteOrgFeature(ORG, true);
    expect(set).toHaveBeenCalledTimes(2);
    t += 61_000;
    await cache.noteOrgFeature(ORG, true);
    expect(set).toHaveBeenCalledTimes(3);
  });
});

describe('7. a database without the runner tables', () => {
  it('execution routing for an org WITH the feature falls through to today\'s path (no 500)', async () => {
    const deps = testDeps();
    deps.store.tablesPresent = async () => false;
    deps.store.getRegistryLink = async () => { throw new Error('column "runner_id" does not exist'); };
    const out = await routeExecution(input({ orgHasFeature: true }), async () => ({ executionId: 'e-1' }), deps);
    expect(out).toEqual({ kind: 'platform', value: { executionId: 'e-1' } });
  });

  it('…and a platform "not found" is today\'s error, not discovery', async () => {
    const deps = testDeps();
    add(deps);
    deps.store.tablesPresent = async () => false;
    await expect(routeExecution(input({ orgHasFeature: true }), () => Promise.reject(new Error('PE_AWS_PIPELINE_NOT_FOUND')), deps)).rejects.toThrow('PE_AWS_PIPELINE_NOT_FOUND');
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });
});
