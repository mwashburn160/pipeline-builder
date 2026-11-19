// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Routing matrix: linked runner (eligible / unhealthy / ineligible), the
 * platform-account path unchanged, discovery (one match, several, none,
 * ambiguous pipeline, no runner, all unreachable), team inheritance order,
 * and the per-(org, pipeline) rate limit.
 */

import { jest, describe, expect, it, beforeEach } from '@jest/globals';

const mockFindById = jest.fn<(id: string, orgId: string) => Promise<unknown>>();
jest.unstable_mockModule('../../src/services/pipeline-service.js', () => ({ pipelineService: { findById: mockFindById } }));

const { routeExecution } = await import('../../src/runners/execution-routing.js');
const { eligibleRunners, RunnerRouteError } = await import('../../src/runners/routing.js');
const { claimsOf, GRANDPARENT, ORG, PARENT, PIPE, reply, runnerRow, testDeps } = await import('../helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
const input = (over: Record<string, unknown> = {}) => ({ pipelineId: PIPE, orgId: ORG, requestedBy: 'user-1', action: 'start' as const, ...over });
const notFound = () => Promise.reject(new Error('PE_AWS_PIPELINE_NOT_FOUND'));
const notRegistered = () => Promise.reject(new Error('PE_PIPELINE_NOT_REGISTERED'));

function addRunner(deps: Deps, over: Parameters<typeof runnerRow>[0] = {}) {
  const r = runnerRow(over);
  deps.store.runners.set(r.id, r);
  return r;
}

async function refusal(p: Promise<unknown>) {
  try { await p; } catch (err) { return err as InstanceType<typeof RunnerRouteError>; }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  mockFindById.mockReset();
  mockFindById.mockResolvedValue({ id: PIPE });
});

describe('eligibleRunners (team inheritance)', () => {
  it('own runners first, then ancestors\' SHARED active runners, nearest first', async () => {
    const deps = testDeps();
    deps.ancestors.push(PARENT, GRANDPARENT);
    const grand = addRunner(deps, { orgId: GRANDPARENT, label: 'grand' });
    const parentShared = addRunner(deps, { orgId: PARENT, label: 'parent' });
    addRunner(deps, { orgId: PARENT, label: 'parent-private', shareWithTeams: false });
    addRunner(deps, { orgId: PARENT, label: 'parent-revoked', status: 'revoked' });
    const own = addRunner(deps, { orgId: ORG, label: 'own', shareWithTeams: false });
    addRunner(deps, { orgId: 'ffffffffffffffffffffffff', label: 'stranger' });
    const got = await eligibleRunners(deps, ORG);
    expect(got.map((e) => [e.runner.id, e.depth])).toEqual([[own.id, 0], [parentShared.id, 1], [grand.id, 2]]);
  });
});

describe('routeExecution', () => {
  it('a malformed id goes the platform way (today\'s 404), untouched', async () => {
    const deps = testDeps();
    await expect(routeExecution(input({ pipelineId: 'nope' }), notRegistered, deps)).rejects.toThrow('PE_PIPELINE_NOT_REGISTERED');
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('a pipeline the caller cannot see is "not registered" (no runner is asked)', async () => {
    const deps = testDeps();
    addRunner(deps);
    mockFindById.mockResolvedValue(null);
    await expect(routeExecution(input(), notFound, deps)).rejects.toThrow('PE_PIPELINE_NOT_REGISTERED');
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('no link → the platform-account call runs and its result is returned', async () => {
    const deps = testDeps();
    addRunner(deps);
    const out = await routeExecution(input(), async () => ({ executionId: 'e-1' }), deps);
    expect(out).toEqual({ kind: 'platform', value: { executionId: 'e-1' } });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('linked to an eligible healthy runner → recorded and enqueued (the platform is not called)', async () => {
    const deps = testDeps();
    const r = addRunner(deps);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: 'us-east-1', runnerId: r.id });
    const platform = jest.fn(async () => ({ executionId: 'x' }));
    const out = await routeExecution(input(), platform, deps);
    expect(out).toMatchObject({ kind: 'queued', status: 'queued', runnerLabel: r.label, runnerId: r.id });
    expect(platform).not.toHaveBeenCalled();
    const row = deps.store.requests.get((out as { requestId: string }).requestId)!;
    expect(row).toMatchObject({ action: 'start', status: 'queued', runnerId: r.id, requestedBy: 'user-1', orgId: ORG });
    expect(row.expiresAt.getTime() - deps.clock.t).toBe(600_000);
    expect(deps.enqueued).toEqual([{ requestId: row.id }]);
  });

  it('linked to an UNREACHABLE runner → 409 RUNNER_UNREACHABLE with details (never a silent queue)', async () => {
    const deps = testDeps();
    const r = addRunner(deps, { health: 'unreachable', lastDeliveryAt: new Date('2026-11-18T00:00:00Z') });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    const err = await refusal(routeExecution(input(), notFound, deps));
    expect(err).toMatchObject({ status: 409, code: 'RUNNER_UNREACHABLE', details: { runnerLabel: r.label, lastDeliveryAt: '2026-11-18T00:00:00.000Z' } });
    expect(deps.store.requests.size).toBe(0);
  });

  it('linked to a runner that is no longer eligible (revoked / unshared) → the platform path', async () => {
    const deps = testDeps();
    deps.ancestors.push(PARENT);
    const r = addRunner(deps, { orgId: PARENT, shareWithTeams: false });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    expect(await routeExecution(input(), async () => ({ executionId: 'e' }), deps)).toEqual({ kind: 'platform', value: { executionId: 'e' } });
  });

  it('a stop through a runner carries the execution id', async () => {
    const deps = testDeps();
    const r = addRunner(deps);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    const out = await routeExecution(input({ action: 'stop', executionId: 'exec-7' }), async () => undefined, deps);
    expect(deps.store.requests.get((out as { requestId: string }).requestId)).toMatchObject({ action: 'stop', executionId: 'exec-7' });
  });

  it('an AWS error other than not-found is rethrown unchanged', async () => {
    const deps = testDeps();
    addRunner(deps);
    await expect(routeExecution(input(), () => Promise.reject(new Error('PE_AWS_ERROR')), deps)).rejects.toThrow('PE_AWS_ERROR');
  });

  describe('discovery (platform says not found)', () => {
    it('no runner → 409 NO_RUNNER; not registered and no runner → today\'s 404', async () => {
      const deps = testDeps();
      expect(await refusal(routeExecution(input(), notFound, deps))).toMatchObject({ status: 409, code: 'NO_RUNNER' });
      await expect(routeExecution(input(), notRegistered, deps)).rejects.toThrow('PE_PIPELINE_NOT_REGISTERED');
    });

    it('exactly one match → links the pipeline to it and enqueues the start', async () => {
      const deps = testDeps();
      const a = addRunner(deps, { label: 'a' });
      const b = addRunner(deps, { label: 'b' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'acme', region: 'us-east-2', runnerId: null });
      deps.fetchMock.mockImplementation(async (_url, opts) => reply(200, { outcome: claimsOf(String(opts.body)).aud === b.id ? 'match' : 'no_match' }));
      const out = await routeExecution(input(), notFound, deps);
      expect(out).toMatchObject({ kind: 'queued', runnerId: b.id, runnerLabel: 'b' });
      expect(deps.store.registry.get(PIPE)!.runnerId).toBe(b.id);
      // Both were probed in parallel, with the hint, and their probes recorded.
      const probes = deps.fetchMock.mock.calls.map(([, o]) => claimsOf(String(o.body)));
      expect(probes.map((c) => c.action)).toEqual(['probe', 'probe']);
      expect(probes[0]).toMatchObject({ pipelineId: PIPE, hint: { region: 'us-east-2', pipelineName: 'acme' } });
      const rows = [...deps.store.requests.values()].filter((r) => r.action === 'probe');
      expect(rows.map((r) => [r.runnerId, r.status, r.errorCode]).sort()).toEqual([[a.id, 'failed', 'NO_MATCH'], [b.id, 'started', null]].sort());
    });

    it('also discovers for a pipeline with no registry row (and leaves it unlinked)', async () => {
      const deps = testDeps();
      const a = addRunner(deps);
      deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
      expect(await routeExecution(input(), notRegistered, deps)).toMatchObject({ kind: 'queued', runnerId: a.id });
      expect(deps.store.registry.size).toBe(0);
    });

    it('more than one match → 409 AMBIGUOUS_RUNNER naming them; nothing is linked', async () => {
      const deps = testDeps();
      addRunner(deps, { label: 'a' }); addRunner(deps, { label: 'b' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
      deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
      expect(await refusal(routeExecution(input(), notFound, deps))).toMatchObject({ status: 409, code: 'AMBIGUOUS_RUNNER', details: { runnersChecked: ['a', 'b'] } });
      expect(deps.store.registry.get(PIPE)!.runnerId).toBeNull();
    });

    it('a runner seeing two pipelines with the tag → 409 AMBIGUOUS_PIPELINE', async () => {
      const deps = testDeps();
      addRunner(deps, { label: 'a' });
      deps.fetchMock.mockResolvedValue(reply(409, { errorCode: 'AMBIGUOUS_PIPELINE' }));
      expect(await refusal(routeExecution(input(), notFound, deps))).toMatchObject({ status: 409, code: 'AMBIGUOUS_PIPELINE', details: { runnersChecked: ['a'] } });
    });

    it('no match anywhere → 404 PIPELINE_NOT_FOUND_IN_RUNNERS listing who was asked; a failed probe counts against health', async () => {
      const deps = testDeps();
      const a = addRunner(deps, { label: 'a' }); addRunner(deps, { label: 'b' });
      deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'no_match' })).mockRejectedValueOnce(new Error('timeout'));
      expect(await refusal(routeExecution(input(), notFound, deps))).toMatchObject({ status: 404, code: 'PIPELINE_NOT_FOUND_IN_RUNNERS', details: { runnersChecked: ['a', 'b'] } });
      expect([...deps.store.runners.values()].find((r) => r.id !== a.id)!.consecutiveFailures).toBe(1);
    });

    it('every eligible runner unreachable → 409 RUNNER_UNREACHABLE without probing', async () => {
      const deps = testDeps();
      addRunner(deps, { health: 'unreachable' });
      expect(await refusal(routeExecution(input(), notFound, deps))).toMatchObject({ status: 409, code: 'RUNNER_UNREACHABLE' });
      expect(deps.fetchMock).not.toHaveBeenCalled();
    });

    it('inherited runners are probed too (a team with no runner of its own)', async () => {
      const deps = testDeps();
      deps.ancestors.push(PARENT);
      const p = addRunner(deps, { orgId: PARENT, label: 'parent' });
      deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
      expect(await routeExecution(input({ parentOrgId: PARENT }), notFound, deps)).toMatchObject({ runnerId: p.id, runnerLabel: 'parent' });
    });
  });

  it('rate-limits runner starts/stops per (org, pipeline) at 6 a minute', async () => {
    const deps = testDeps();
    const r = addRunner(deps);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    // Stops (a second START of the same pipeline is de-duplicated instead).
    const stop = (i: number) => input({ action: 'stop', executionId: `e-${i}` });
    for (let i = 0; i < 6; i++) await routeExecution(stop(i), notFound, deps);
    expect(await refusal(routeExecution(stop(7), notFound, deps))).toMatchObject({ status: 429, code: 'RUN_REQUEST_RATE_LIMITED' });
    expect(deps.store.requests.size).toBe(6);
  });
});
