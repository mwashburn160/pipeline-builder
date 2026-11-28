// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Routing matrix: linked runner (eligible / unhealthy / ineligible), discovery
 * when unlinked (one match, several, none, ambiguous pipeline, no runner, all
 * unreachable), nearest level wins for sub-orgs, the runner-link columns every
 * probe writes, background linking at registration, and the configurable limits.
 */

import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';

const mockFindById = jest.fn<(id: string, orgId: string) => Promise<unknown>>();
jest.unstable_mockModule('../../src/services/pipeline-service.js', () => ({ pipelineService: { findById: mockFindById } }));

const { routeExecution } = await import('../../src/runners/execution-routing.js');
const { eligibleRunners, linkInBackground, probeRunnerLink, rediscoverRequest, RunnerRouteError, startLink } = await import('../../src/runners/routing.js');
const { claimsOf, GRANDPARENT, ORG, PARENT, PIPE, reply, runnerRow, testDeps } = await import('../helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
const input = (over: Record<string, unknown> = {}) => ({ pipelineId: PIPE, orgId: ORG, requestedBy: 'user-1', action: 'start' as const, ...over });
const matchFor = (deps: Deps, ...ids: string[]) => deps.fetchMock.mockImplementation(async (_url, opts) => reply(200, { outcome: ids.includes(String(claimsOf(String(opts.body)).aud)) ? 'match' : 'no_match' }));
const ENV = { ...process.env };

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
afterEach(() => { process.env = { ...ENV }; });

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

describe('routeExecution (runners are the only path)', () => {
  it('a malformed id is 400 VALIDATION_ERROR, untouched', async () => {
    const deps = testDeps();
    expect(await refusal(routeExecution(input({ pipelineId: 'nope' }), deps))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  // A malformed or over-long stop execution id used to reach discovery (signed
  // probes to every runner) and then fail the insert (varchar(100)) with a 500.
  it.each(['x'.repeat(101), 'exec id', 'exec/../1'])('a malformed stop execution id (%s) is 400 VALIDATION_ERROR, no runner asked', async (executionId) => {
    const deps = testDeps();
    addRunner(deps);
    expect(await refusal(routeExecution(input({ action: 'stop', executionId }), deps))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('runners unavailable (paused) → 409 RUNNERS_UNAVAILABLE, nothing read', async () => {
    const deps = testDeps();
    addRunner(deps);
    deps.availability.available = false;
    deps.availability.reason = 'paused';
    expect(await refusal(routeExecution(input(), deps))).toMatchObject({ status: 409, code: 'RUNNERS_UNAVAILABLE' });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('a pipeline the caller cannot see is 404 NOT_FOUND (no runner is asked)', async () => {
    const deps = testDeps();
    addRunner(deps);
    mockFindById.mockResolvedValue(null);
    expect(await refusal(routeExecution(input(), deps))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('linked to an eligible healthy runner → recorded and enqueued, no probe', async () => {
    const deps = testDeps();
    const r = addRunner(deps);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: 'us-east-1', runnerId: r.id });
    const out = await routeExecution(input(), deps);
    expect(out).toMatchObject({ status: 'queued', runnerLabel: r.label, runnerId: r.id, reused: false });
    expect(deps.fetchMock).not.toHaveBeenCalled();
    const row = deps.store.requests.get(out.requestId)!;
    expect(row).toMatchObject({ action: 'start', status: 'queued', runnerId: r.id, requestedBy: 'user-1', orgId: ORG });
    expect(row.expiresAt.getTime() - deps.clock.t).toBe(600_000);
    expect(deps.enqueued).toEqual([{ requestId: row.id }]);
  });

  it('linked to an UNREACHABLE runner → 409 RUNNER_UNREACHABLE with details (never a silent queue)', async () => {
    const deps = testDeps();
    const r = addRunner(deps, { health: 'unreachable', lastDeliveryAt: new Date('2026-11-18T00:00:00Z') });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    const err = await refusal(routeExecution(input(), deps));
    expect(err).toMatchObject({ status: 409, code: 'RUNNER_UNREACHABLE', details: { runnerLabel: r.label, lastDeliveryAt: '2026-11-18T00:00:00.000Z' } });
    expect(deps.store.requests.size).toBe(0);
  });

  it('linked to a runner that is no longer eligible (unshared) → discovery among the eligible ones', async () => {
    const deps = testDeps();
    deps.ancestors.push(PARENT);
    const gone = addRunner(deps, { orgId: PARENT, shareWithTeams: false });
    const own = addRunner(deps, { label: 'own' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: gone.id });
    matchFor(deps, own.id);
    expect(await routeExecution(input(), deps)).toMatchObject({ runnerId: own.id });
    expect(deps.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a stop through a runner carries the execution id', async () => {
    const deps = testDeps();
    const r = addRunner(deps);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    const out = await routeExecution(input({ action: 'stop', executionId: 'exec-7' }), deps);
    expect(deps.store.requests.get(out.requestId)).toMatchObject({ action: 'stop', executionId: 'exec-7' });
  });

  describe('discovery (unlinked)', () => {
    it('no runner → 409 NO_RUNNER pointing at Settings → Pipeline runners, recorded on the row', async () => {
      const deps = testDeps();
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
      const err = await refusal(routeExecution(input(), deps));
      expect(err).toMatchObject({ status: 409, code: 'NO_RUNNER' });
      expect(err.message).toContain('Settings → Pipeline runners');
      expect(deps.store.registry.get(PIPE)).toMatchObject({ linkStatus: 'not_found', linkDetail: { runnersChecked: [], matched: [], errorCode: 'NO_RUNNER' } });
    });

    it('exactly one match → links the pipeline to it (status, checked-at, detail) and enqueues the start', async () => {
      const deps = testDeps();
      const a = addRunner(deps, { label: 'a' });
      const b = addRunner(deps, { label: 'b' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'acme', region: 'us-east-2', runnerId: null });
      matchFor(deps, b.id);
      const out = await routeExecution(input(), deps);
      expect(out).toMatchObject({ runnerId: b.id, runnerLabel: 'b' });
      expect(deps.store.registry.get(PIPE)).toMatchObject({
        runnerId: b.id, linkStatus: 'linked', linkCheckedAt: new Date(deps.clock.t), linkDetail: { runnersChecked: ['a', 'b'], matched: ['b'], errorCode: null },
      });
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
      expect(await routeExecution(input(), deps)).toMatchObject({ runnerId: a.id });
      expect(deps.store.registry.size).toBe(0);
    });

    it('more than one match at the same level → 409 AMBIGUOUS_RUNNER naming them and the one-runner-per-account rule; the old link is kept', async () => {
      const deps = testDeps();
      const old = addRunner(deps, { label: 'old', status: 'revoked' });
      addRunner(deps, { label: 'a' }); addRunner(deps, { label: 'b' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: old.id });
      deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
      const err = await refusal(routeExecution(input(), deps));
      expect(err).toMatchObject({ status: 409, code: 'AMBIGUOUS_RUNNER', details: { runnersChecked: ['a', 'b'] } });
      expect(err.message).toMatch(/one runner per AWS account/);
      expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: old.id, linkStatus: 'ambiguous', linkDetail: { matched: ['a', 'b'], errorCode: 'AMBIGUOUS_RUNNER' } });
    });

    it('Run with a chosen runner (none linked): only that runner is probed, and it is linked', async () => {
      const deps = testDeps();
      addRunner(deps, { label: 'a' });
      const b = addRunner(deps, { label: 'b' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
      // Both would match: without the choice this is AMBIGUOUS_RUNNER.
      deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
      expect(await routeExecution(input({ runnerId: b.id }), deps)).toMatchObject({ runnerId: b.id, runnerLabel: 'b' });
      expect(deps.fetchMock).toHaveBeenCalledTimes(1);
      expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: b.id, linkStatus: 'linked' });
    });

    it('Run with a chosen runner never overrides a usable linked runner', async () => {
      const deps = testDeps();
      const a = addRunner(deps, { label: 'a' });
      const b = addRunner(deps, { label: 'b' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: a.id, linkStatus: 'linked' });
      expect(await routeExecution(input({ runnerId: b.id }), deps)).toMatchObject({ runnerId: a.id });
      expect(deps.fetchMock).not.toHaveBeenCalled();
    });

    it('Run with a runner the org cannot use → 400 VALIDATION_ERROR, nothing probed', async () => {
      const deps = testDeps();
      addRunner(deps, { label: 'a' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
      expect(await refusal(routeExecution(input({ runnerId: '99999999-9999-4999-8999-999999999999' }), deps))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
      expect(deps.fetchMock).not.toHaveBeenCalled();
    });

    it('a runner seeing two pipelines with the tag → 409 AMBIGUOUS_PIPELINE', async () => {
      const deps = testDeps();
      addRunner(deps, { label: 'a' });
      deps.fetchMock.mockResolvedValue(reply(409, { errorCode: 'AMBIGUOUS_PIPELINE' }));
      expect(await refusal(routeExecution(input(), deps))).toMatchObject({ status: 409, code: 'AMBIGUOUS_PIPELINE', details: { runnersChecked: ['a'] } });
    });

    it('no match anywhere → 404 PIPELINE_NOT_FOUND_IN_RUNNERS listing who was asked; recorded not_found; a failed probe counts against health', async () => {
      const deps = testDeps();
      const a = addRunner(deps, { label: 'a' }); addRunner(deps, { label: 'b' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
      deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'no_match' })).mockRejectedValueOnce(new Error('timeout'));
      expect(await refusal(routeExecution(input(), deps))).toMatchObject({ status: 404, code: 'PIPELINE_NOT_FOUND_IN_RUNNERS', details: { runnersChecked: ['a', 'b'] } });
      expect([...deps.store.runners.values()].find((r) => r.id !== a.id)!.consecutiveFailures).toBe(1);
      expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: null, linkStatus: 'not_found', linkDetail: { runnersChecked: ['a', 'b'], matched: [], errorCode: 'PIPELINE_NOT_FOUND_IN_RUNNERS' } });
    });

    it('a probe whose runner is gone (AWS 403 "URL gone" / NXDOMAIN) marks it unreachable at once, as delivery does', async () => {
      const deps = testDeps();
      const a = addRunner(deps, { label: 'a' });
      deps.fetchMock.mockResolvedValueOnce(reply(403, { Message: 'Forbidden' }));
      expect(await refusal(routeExecution(input(), deps))).toMatchObject({ code: 'PIPELINE_NOT_FOUND_IN_RUNNERS' });
      expect(deps.store.runners.get(a.id)).toMatchObject({ health: 'unreachable', consecutiveFailures: 1 });
    });

    it('every eligible runner unreachable → 409 RUNNER_UNREACHABLE without probing', async () => {
      const deps = testDeps();
      addRunner(deps, { health: 'unreachable' });
      expect(await refusal(routeExecution(input(), deps))).toMatchObject({ status: 409, code: 'RUNNER_UNREACHABLE' });
      expect(deps.fetchMock).not.toHaveBeenCalled();
    });

    it('a probe that blows up mid-way never leaves the row `checking`', async () => {
      const deps = testDeps();
      addRunner(deps);
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null, linkStatus: 'not_found' });
      deps.store.insertRequest = async () => { throw new Error('db down'); };
      await expect(routeExecution(input(), deps)).rejects.toThrow('db down');
      expect(deps.store.registry.get(PIPE)!.linkStatus).toBe('not_found');
    });
  });

  describe('sub-organizations: nearest level wins', () => {
    it('a team with no runner of its own routes through its parent\'s shared runner, signed with the PARENT\'s key', async () => {
      const deps = testDeps();
      deps.ancestors.push(PARENT);
      const p = addRunner(deps, { orgId: PARENT, label: 'parent' });
      deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
      expect(await routeExecution(input({ parentOrgId: PARENT }), deps)).toMatchObject({ runnerId: p.id, runnerLabel: 'parent' });
      // signerFor is asked for the runner ROW's org (the owner), never the caller's.
      expect(deps.signerOrgs).toEqual([PARENT]);
    });

    it('when both the team\'s own runner and the parent\'s shared runner match, the team\'s runner wins (not AMBIGUOUS_RUNNER)', async () => {
      const deps = testDeps();
      deps.ancestors.push(PARENT);
      addRunner(deps, { orgId: PARENT, label: 'parent' });
      const own = addRunner(deps, { label: 'own' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
      deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
      expect(await routeExecution(input({ parentOrgId: PARENT }), deps)).toMatchObject({ runnerId: own.id });
      expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: own.id, linkStatus: 'linked', linkDetail: { matched: ['own'] } });
    });

    it('a nearer level with no match falls through to the next level', async () => {
      const deps = testDeps();
      deps.ancestors.push(PARENT, GRANDPARENT);
      addRunner(deps, { label: 'own' });
      const grand = addRunner(deps, { orgId: GRANDPARENT, label: 'grand' });
      matchFor(deps, grand.id);
      expect(await routeExecution(input(), deps)).toMatchObject({ runnerId: grand.id });
    });

    it('two matches at the same (ancestor) level still give AMBIGUOUS_RUNNER', async () => {
      const deps = testDeps();
      deps.ancestors.push(PARENT);
      addRunner(deps, { orgId: PARENT, label: 'p1' });
      addRunner(deps, { orgId: PARENT, label: 'p2' });
      deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
      expect(await refusal(routeExecution(input(), deps))).toMatchObject({ code: 'AMBIGUOUS_RUNNER', details: { runnersChecked: ['p1', 'p2'] } });
    });

    it('rediscovery uses the same rule: the team\'s other own runner beats the parent\'s', async () => {
      const deps = testDeps();
      deps.ancestors.push(PARENT);
      const failed = addRunner(deps, { label: 'failed' });
      addRunner(deps, { orgId: PARENT, label: 'parent' });
      const other = addRunner(deps, { label: 'other' });
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
      deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
      const request = await deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', expiresAt: new Date(deps.clock.t + 600_000), runnerId: failed.id });
      expect(await rediscoverRequest(deps, request, failed)).toBe(true);
      expect(deps.store.requests.get(request.id)!.runnerId).toBe(other.id);
      expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: other.id, linkStatus: 'linked' });
    });
  });

  describe('limits (configurable; system-initiated runs queue past the pending cap)', () => {
    it('rate-limits user starts/stops per (org, pipeline) at RUN_REQUESTS_PER_MINUTE (default 6)', async () => {
      const deps = testDeps();
      const r = addRunner(deps);
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
      // Stops (a second START of the same pipeline is de-duplicated instead).
      const stop = (i: number) => input({ action: 'stop', executionId: `e-${i}` });
      for (let i = 0; i < 6; i++) await routeExecution(stop(i), deps);
      expect(await refusal(routeExecution(stop(7), deps))).toMatchObject({ status: 429, code: 'RUN_REQUEST_RATE_LIMITED' });
      expect(deps.store.requests.size).toBe(6);
    });

    it('RUN_REQUESTS_PER_MINUTE from the env', async () => {
      process.env.RUN_REQUESTS_PER_MINUTE = '2';
      const deps = testDeps();
      const r = addRunner(deps);
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
      const stop = (i: number) => input({ action: 'stop', executionId: `e-${i}` });
      await routeExecution(stop(1), deps); await routeExecution(stop(2), deps);
      expect(await refusal(routeExecution(stop(3), deps))).toMatchObject({ code: 'RUN_REQUEST_RATE_LIMITED' });
    });

    it('a plugin-upgrade fan-out of 60 pipelines queues every run past MAX_PENDING_PER_ORG; a user run at the cap still gets 429', async () => {
      process.env.MAX_PENDING_PER_ORG = '10';
      const deps = testDeps();
      const r = addRunner(deps);
      const ids = Array.from({ length: 60 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`);
      for (const id of ids) deps.store.registry.set(id, { orgId: ORG, pipelineName: id, region: null, runnerId: r.id });
      for (const id of ids) await routeExecution(input({ pipelineId: id, requestedBy: 'system:plugin-upgrade' }), deps);
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
      expect([...deps.store.requests.values()].filter((q) => q.action === 'start' && q.status === 'queued')).toHaveLength(60);
      expect(deps.enqueued).toHaveLength(60);
      expect(await refusal(routeExecution(input(), deps))).toMatchObject({ status: 429, code: 'TOO_MANY_PENDING' });
    });
  });
});

describe('background linking at registration', () => {
  it('probes the org\'s runners and saves the link, so the first Run goes straight to its runner', async () => {
    const deps = testDeps();
    const r = addRunner(deps, { label: 'prod' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
    expect(await linkInBackground(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'system:runner-link' })).toBe('linked');
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: r.id, linkStatus: 'linked' });
    deps.fetchMock.mockClear();
    expect(await routeExecution(input(), deps)).toMatchObject({ runnerId: r.id });
    expect(deps.fetchMock).not.toHaveBeenCalled(); // no discovery on Run
  });

  it('a failed or ambiguous probe is recorded (never thrown), and Run falls back to discovery', async () => {
    const deps = testDeps();
    addRunner(deps, { label: 'a' }); addRunner(deps, { label: 'b' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
    expect(await linkInBackground(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'system:runner-link' })).toBe('ambiguous');
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: null, linkStatus: 'ambiguous' });
    // The ambiguity is resolved (one runner revoked): Run discovers and links.
    const [first] = [...deps.store.runners.values()];
    deps.store.runners.set(first!.id, { ...first!, status: 'revoked' });
    expect(await routeExecution(input(), deps)).toMatchObject({ runnerLabel: 'b' });
    expect(deps.store.registry.get(PIPE)!.linkStatus).toBe('linked');
  });

  it('a runner picked at registration is the only one probed (two runners that both match link the picked one)', async () => {
    const deps = testDeps();
    addRunner(deps, { label: 'a' });
    const b = addRunner(deps, { label: 'b' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
    expect(await linkInBackground(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'system:runner-link', runnerId: b.id })).toBe('linked');
    expect(deps.fetchMock).toHaveBeenCalledTimes(1);
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: b.id, linkStatus: 'linked' });
  });

  it('a picked runner that does not find an unlinked pipeline records not_found', async () => {
    const deps = testDeps();
    addRunner(deps, { label: 'a' });
    const b = addRunner(deps, { label: 'b' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'no_match' }));
    expect(await linkInBackground(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'system:runner-link', runnerId: b.id })).toBe('not_found');
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: null, linkStatus: 'not_found', linkDetail: { runnersChecked: ['b'] } });
  });

  it('a picked runner that misses never breaks a working link to another runner: it stays linked, Run still goes there', async () => {
    const deps = testDeps();
    const a = addRunner(deps, { label: 'a' });
    const b = addRunner(deps, { label: 'b' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: a.id, linkStatus: 'linked' });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'no_match' }));
    expect(await linkInBackground(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'system:runner-link', runnerId: b.id })).toBe('not_found');
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: a.id, linkStatus: 'linked' });
    deps.fetchMock.mockClear();
    expect(await routeExecution(input(), deps)).toMatchObject({ runnerId: a.id });
  });

  it('startLink marks the row checking before answering, and reports the outcome through done', async () => {
    const deps = testDeps();
    const r = addRunner(deps, { label: 'prod' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
    let release!: () => void;
    deps.fetchMock.mockImplementation(() => new Promise((ok) => { release = () => ok(reply(200, { outcome: 'match' })); }));
    const started = await startLink(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'system:runner-link', runnerId: r.id });
    expect(started).toMatchObject({ status: 'checking', probed: true });
    expect(deps.store.registry.get(PIPE)!.linkStatus).toBe('checking');
    await new Promise((ok) => setTimeout(ok, 0));
    release();
    expect(await started.done).toBe('linked');
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: r.id, linkStatus: 'linked' });
  });

  it('startLink probes nothing when runners are unavailable or the pipeline is already linked to the picked runner', async () => {
    const deps = testDeps();
    const r = addRunner(deps);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id, linkStatus: 'linked' });
    expect(await startLink(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'u', runnerId: r.id })).toMatchObject({ status: 'linked', probed: false });
    deps.availability.available = false;
    expect(await startLink(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'u' })).toMatchObject({ status: null, probed: false });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when runners are unavailable, the pipeline is unregistered, or it is already linked', async () => {
    const deps = testDeps();
    const r = addRunner(deps);
    expect(await linkInBackground(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'system:runner-link' })).toBeNull();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id, linkStatus: 'linked' });
    expect(await linkInBackground(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'system:runner-link' })).toBe('linked');
    deps.availability.available = false;
    expect(await linkInBackground(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'system:runner-link' })).toBeNull();
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('probeRunnerLink keeps the old link on anything but a single match', async () => {
    const deps = testDeps();
    const old = addRunner(deps, { label: 'old' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: old.id, linkStatus: 'linked' });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'no_match' }));
    expect(await probeRunnerLink(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'u' })).toBe('not_found');
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: old.id, linkStatus: 'not_found', linkDetail: { runnersChecked: ['old'] } });
  });
});
