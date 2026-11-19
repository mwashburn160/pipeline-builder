// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The amendment-b behaviours (G1–G12, G15), one describe per gap. */

import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';

const mockFindById = jest.fn<(id: string, orgId: string) => Promise<unknown>>();
jest.unstable_mockModule('../../src/services/pipeline-service.js', () => ({ pipelineService: { findById: mockFindById } }));

const { registerRunner, testRunner, updateRunner, runnerDto } = await import('../../src/runners/admin.js');
const { processDelivery, runSweep } = await import('../../src/runners/lifecycle.js');
const { routeExecution, isCredentialError } = await import('../../src/runners/execution-routing.js');
const { eligibleRunners } = await import('../../src/runners/routing.js');
const { readRunRequest, resetRunRequestCachesForTesting } = await import('../../src/runners/run-request-status.js');
const { runnerSettings, versionBelow } = await import('../../src/runners/vocabulary.js');
const { claimsOf, ORG, PIPE, reply, runnerRow, testDeps, URL_A } = await import('../helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
const DAY = 24 * 60 * 60_000;
const input = (over: Record<string, unknown> = {}) => ({ pipelineId: PIPE, orgId: ORG, requestedBy: 'user-1', action: 'start' as const, ...over });
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (err) { return err as { status: number; code: string }; }
  throw new Error('expected a refusal');
}
function add(deps: Deps, over: Parameters<typeof runnerRow>[0] = {}) {
  const r = runnerRow(over); deps.store.runners.set(r.id, r); return r;
}
async function queued(deps: Deps, runnerId: string, over: Record<string, unknown> = {}) {
  return deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'user-1', requestedAt: new Date(deps.clock.t), expiresAt: new Date(deps.clock.t + 600_000), runnerId, ...over });
}

const ENV = { ...process.env };
beforeEach(() => {
  mockFindById.mockReset(); mockFindById.mockResolvedValue({ id: PIPE });
  resetRunRequestCachesForTesting();
});
afterEach(() => { process.env = { ...ENV }; });

describe('G1 register-then-deploy (pending runners)', () => {
  it('POST without a URL creates a pending runner and sends nothing', async () => {
    const deps = testDeps();
    const r = await registerRunner(deps, ORG, 'u', { label: 'new' });
    expect(r).toMatchObject({ status: 'pending', functionUrl: null });
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(runnerDto(r, ORG).status).toBe('pending');
  });

  it('PATCH functionUrl pings with aud = the runner id and activates it', async () => {
    const deps = testDeps();
    const r = await registerRunner(deps, ORG, 'u', { label: 'new' });
    const { runner, changed } = await updateRunner(deps, ORG, 'u', r.id, { functionUrl: URL_A });
    expect(claimsOf(String(deps.fetchMock.mock.calls[0]![1].body))).toMatchObject({ action: 'ping', aud: r.id });
    expect(runner).toMatchObject({ status: 'active', functionUrl: URL_A, version: '1.2.3', regions: ['us-east-1'] });
    expect(changed).toEqual(['functionUrl', 'status']);
  });

  it('a pending runner is never routed to, cannot be tested, and is swept after 24 h', async () => {
    const deps = testDeps();
    const p = add(deps, { status: 'pending', functionUrl: null, createdAt: new Date(deps.clock.t - DAY - 1) });
    const fresh = add(deps, { status: 'pending', functionUrl: null, createdAt: new Date(deps.clock.t) });
    expect(await eligibleRunners(deps, ORG)).toEqual([]);
    expect(await refusal(testRunner(deps, ORG, 'u', fresh.id))).toMatchObject({ status: 409, code: 'RUNNER_PENDING' });
    expect((await runSweep(deps)).pendingDeleted).toBe(1);
    expect(deps.store.runners.has(p.id)).toBe(false);
    expect(deps.store.runners.has(fresh.id)).toBe(true);
  });
});

describe('G2 / G11 run-request status read', () => {
  it('a started request refreshes executionStatus with a read-only signed status request, at most every 15 s', async () => {
    const deps = testDeps();
    const r = add(deps);
    const q = await queued(deps, r.id, { status: 'started', resultExecutionId: 'exec-1' });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'status', executionId: 'exec-1', executionStatus: 'InProgress' }));
    const dto = await readRunRequest(deps, ORG, PIPE, q.id);
    expect(dto).toMatchObject({ requestId: q.id, status: 'started', executionId: 'exec-1', executionStatus: 'InProgress', runnerLabel: r.label });
    expect(claimsOf(String(deps.fetchMock.mock.calls[0]![1].body))).toMatchObject({ action: 'status', executionId: 'exec-1', pipelineId: PIPE, aud: r.id });
    // Inside 2 s: the cached DTO (no row read, no runner call).
    deps.clock.t += 1_000;
    await readRunRequest(deps, ORG, PIPE, q.id);
    expect(deps.fetchMock).toHaveBeenCalledTimes(1);
    // After 2 s but inside 15 s: a fresh row read, the cached execution status.
    deps.clock.t += 5_000;
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'status', executionStatus: 'Succeeded' }));
    expect((await readRunRequest(deps, ORG, PIPE, q.id))!.executionStatus).toBe('InProgress');
    expect(deps.fetchMock).toHaveBeenCalledTimes(1);
    deps.clock.t += 15_000;
    expect((await readRunRequest(deps, ORG, PIPE, q.id))!.executionStatus).toBe('Succeeded');
  });

  it('serves the 2 s cache, and another org\'s (or another pipeline\'s) request is not found', async () => {
    const deps = testDeps();
    const r = add(deps);
    const q = await queued(deps, r.id);
    expect((await readRunRequest(deps, ORG, PIPE, q.id))!.status).toBe('queued');
    deps.store.requests.set(q.id, { ...deps.store.requests.get(q.id)!, status: 'delivering' });
    expect((await readRunRequest(deps, ORG, PIPE, q.id))!.status).toBe('queued');
    deps.clock.t += 2_001;
    expect((await readRunRequest(deps, ORG, PIPE, q.id))!.status).toBe('delivering');
    expect(await readRunRequest(deps, 'ffffffffffffffffffffffff', PIPE, q.id)).toBeNull();
    expect(await readRunRequest(deps, ORG, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', q.id)).toBeNull();
    expect(deps.fetchMock).not.toHaveBeenCalled(); // not started: no status refresh
  });
});

describe('G3 no platform AWS credentials → discovery, never 502', () => {
  const noCreds = () => Promise.reject(Object.assign(new Error('PE_AWS_ERROR'), { awsName: 'CredentialsProviderError', awsMessage: 'Could not load credentials from any providers' }));

  it('discovers through the runners', async () => {
    const deps = testDeps();
    const r = add(deps);
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
    expect(await routeExecution(input(), noCreds, deps)).toMatchObject({ kind: 'queued', runnerId: r.id });
  });

  it('with no runner it is 409 NO_RUNNER, not the AWS error', async () => {
    expect(await refusal(routeExecution(input(), noCreds, testDeps()))).toMatchObject({ status: 409, code: 'NO_RUNNER' });
  });

  it('only credential errors qualify', async () => {
    expect(isCredentialError({ awsName: 'ThrottlingException' })).toBe(false);
    expect(isCredentialError({ awsMessage: 'Region is missing' })).toBe(true);
    await expect(routeExecution(input(), () => Promise.reject(Object.assign(new Error('PE_AWS_ERROR'), { awsName: 'ThrottlingException' })), testDeps())).rejects.toThrow('PE_AWS_ERROR');
  });
});

describe('G4 linked runner no longer finds the pipeline → re-discovery once', () => {
  it('clears the link, probes the other runners, re-targets the SAME request', async () => {
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
    // The same dispatch job delivers it again, at once.
    expect(await processDelivery(deps, q.id)).toEqual({ done: false, retryInMs: 0 });
    expect(deps.store.requests.get(q.id)).toMatchObject({ status: 'queued', runnerId: moved.id, lastDeliveryError: 'rediscovered' });
    expect(deps.store.registry.get(PIPE)!.runnerId).toBe(moved.id);
    await processDelivery(deps, q.id);
    expect(deps.store.requests.get(q.id)).toMatchObject({ status: 'started', resultExecutionId: 'e-2' });
  });

  it('a second not-found does not re-discover again', async () => {
    const deps = testDeps();
    const a = add(deps, { label: 'a' });
    add(deps, { label: 'b' });
    const q = await queued(deps, a.id);
    deps.fetchMock.mockImplementation(async (_u, o) => (claimsOf(String(o.body)).action === 'probe' ? reply(200, { outcome: 'match' }) : reply(404, { errorCode: 'PIPELINE_NOT_FOUND' })));
    await processDelivery(deps, q.id); // a → not found → rediscover → b
    await processDelivery(deps, q.id); // b → not found → already rediscovered
    expect(deps.store.requests.get(q.id)).toMatchObject({ status: 'failed', errorCode: 'PIPELINE_NOT_FOUND' });
  });

  it('no other runner → fails with PIPELINE_NOT_FOUND', async () => {
    const deps = testDeps();
    const a = add(deps);
    const q = await queued(deps, a.id);
    deps.fetchMock.mockResolvedValue(reply(404, { errorCode: 'PIPELINE_NOT_FOUND' }));
    await processDelivery(deps, q.id);
    expect(deps.store.requests.get(q.id)).toMatchObject({ status: 'failed', errorCode: 'PIPELINE_NOT_FOUND' });
  });
});

describe('G5 caps', () => {
  it('≤ 50 pending requests per org → 429 TOO_MANY_PENDING', async () => {
    const deps = testDeps();
    const r = add(deps);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    for (let i = 0; i < 50; i++) await queued(deps, r.id, { pipelineId: `p-${i}`, action: 'stop' });
    expect(await refusal(routeExecution(input(), async () => ({}), deps))).toMatchObject({ status: 429, code: 'TOO_MANY_PENDING' });
  });

  it('≤ 4 deliveries in flight per runner (the 5th waits)', async () => {
    const deps = testDeps();
    const r = add(deps);
    for (let i = 0; i < 4; i++) await queued(deps, r.id, { pipelineId: `p-${i}`, status: 'delivering' });
    const q = await queued(deps, r.id);
    expect(await processDelivery(deps, q.id)).toEqual({ done: false, retryInMs: 1000 });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('RUNNER_DISPATCH_CONCURRENCY sets the dispatcher concurrency (default 16)', () => {
    expect(runnerSettings({}).dispatchConcurrency).toBe(16);
    expect(runnerSettings({ RUNNER_DISPATCH_CONCURRENCY: '4' }).dispatchConcurrency).toBe(4);
    expect(runnerSettings({ RUNNER_DISPATCH_CONCURRENCY: '0' }).dispatchConcurrency).toBe(16);
    expect(runnerSettings({ RUNNER_DISPATCH_CONCURRENCY: 'x' }).dispatchConcurrency).toBe(16);
  });
});

describe('G7 MIN_RUNNER_VERSION', () => {
  it('compares semver', () => {
    expect(versionBelow('1.2.3', '1.3.0')).toBe(true);
    expect(versionBelow('1.10.0', '1.9.9')).toBe(false);
    expect(versionBelow('v2.0.0', '2.0.0')).toBe(false);
    expect(versionBelow('unknown', '2.0.0')).toBe(false);
    expect(versionBelow('1.0.0', null)).toBe(false);
  });

  it('flags a below-minimum runner (updateRequired, one notice), refuses it after the grace period, clears on update', async () => {
    process.env.MIN_RUNNER_VERSION = '2.0.0';
    process.env.RUNNER_UPGRADE_GRACE_DAYS = '30';
    const deps = testDeps();
    const r = add(deps, { version: null });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'pong', runnerVersion: '1.5.0' }));
    await testRunner(deps, ORG, 'u', r.id);
    await testRunner(deps, ORG, 'u', r.id);
    const flagged = deps.store.runners.get(r.id)!;
    expect(flagged.updateRequiredSince).toEqual(new Date(deps.clock.t));
    expect(runnerDto(flagged, ORG).updateRequired).toBe(true);
    expect(deps.notified.filter((n) => (n as { subject: string }).subject.includes('needs an update'))).toHaveLength(1);
    // Inside the grace period: still routed.
    expect(await routeExecution(input({ action: 'stop', executionId: 'e' }), async () => ({}), deps)).toMatchObject({ kind: 'queued' });
    deps.clock.t += 31 * DAY;
    expect(await refusal(routeExecution(input({ action: 'stop', executionId: 'e2' }), async () => ({}), deps))).toMatchObject({ status: 409, code: 'RUNNER_UPDATE_REQUIRED' });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'pong', runnerVersion: '2.1.0' }));
    await testRunner(deps, ORG, 'u', r.id);
    expect(deps.store.runners.get(r.id)!.updateRequiredSince).toBeNull();
  });

  it('without MIN_RUNNER_VERSION nothing is flagged', () => {
    expect(runnerSettings({}).minRunnerVersion).toBeNull();
    expect(runnerDto(runnerRow({ version: '0.0.1' }), ORG).updateRequired).toBe(false);
  });
});

describe('G8 retention sweep', () => {
  it('deletes finished requests after 90 days and failed/expired after 30 (env-overridable)', async () => {
    const deps = testDeps();
    const r = add(deps);
    const at = (days: number) => new Date(deps.clock.t - days * DAY);
    const keep = await queued(deps, r.id, { status: 'started', requestedAt: at(89) });
    const old = await queued(deps, r.id, { status: 'stopped', requestedAt: at(91) });
    const failedOld = await queued(deps, r.id, { status: 'failed', requestedAt: at(31) });
    const failedNew = await queued(deps, r.id, { status: 'expired', requestedAt: at(29) });
    expect((await runSweep(deps)).retained).toBe(2);
    expect([...deps.store.requests.keys()].sort()).toEqual([keep.id, failedNew.id].sort());
    expect(deps.store.requests.has(old.id) || deps.store.requests.has(failedOld.id)).toBe(false);
    expect(runnerSettings({ RUNNER_REQUEST_RETENTION_DAYS: '7', RUNNER_FAILED_REQUEST_RETENTION_DAYS: '2' })).toMatchObject({ retentionDays: 7, failedRetentionDays: 2 });
  });
});

describe('G9 emergency stop: the signing key is removed (checked per job)', () => {
  it('no signing key stops delivery immediately; the request stays queued', async () => {
    let on = true;
    const deps = testDeps();
    const key = deps.signer;
    deps.signer = () => (on ? key() : null);
    const r = add(deps);
    const q = await queued(deps, r.id);
    on = false;
    expect(await processDelivery(deps, q.id)).toEqual({ done: true });
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(deps.store.requests.get(q.id)!.status).toBe('queued');
    // The sweep neither pings nor re-kicks while off…
    add(deps, { health: 'unreachable', updatedAt: new Date(0) });
    expect(await runSweep(deps)).toMatchObject({ pinged: 0, rekicked: 0 });
    // …and re-kicks the queued request once the key is back.
    on = true;
    deps.fetchMock.mockResolvedValue(reply(500, {}));
    expect((await runSweep(deps)).rekicked).toBe(1);
    expect(deps.enqueued.map((e) => e.requestId)).toContain(q.id);
  });
});

describe('G10 failure classes', () => {
  it.each([
    [Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }), 'dns_nxdomain'],
    [null, 'aws_403_url_gone'],
  ])('%s → unreachable immediately, recorded as the class', async (err, cls) => {
    const deps = testDeps();
    const r = add(deps);
    const q = await queued(deps, r.id);
    if (err) deps.fetchMock.mockRejectedValue(err);
    else deps.fetchMock.mockResolvedValue(reply(403, { Message: 'Forbidden' }));
    expect(await processDelivery(deps, q.id)).toEqual({ done: true }); // paused at once
    expect(deps.store.runners.get(r.id)).toMatchObject({ health: 'unreachable', consecutiveFailures: 1 });
    expect(deps.store.requests.get(q.id)!.lastDeliveryError).toBe(cls);
    expect(deps.notified).toHaveLength(1);
  });
});

describe('G12 an in-flight start is reused', () => {
  it('a second Re-run while the first is queued/delivering returns the existing request', async () => {
    const deps = testDeps();
    const r = add(deps);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    const first = await routeExecution(input(), async () => ({}), deps);
    const again = await routeExecution(input(), async () => ({}), deps);
    expect(again).toMatchObject({ kind: 'queued', requestId: (first as { requestId: string }).requestId, status: 'queued' });
    deps.store.requests.set((first as { requestId: string }).requestId, { ...deps.store.requests.get((first as { requestId: string }).requestId)!, status: 'delivering' });
    expect(await routeExecution(input(), async () => ({}), deps)).toMatchObject({ status: 'delivering' });
    expect(deps.store.requests.size).toBe(1);
    expect(deps.enqueued).toHaveLength(1);
  });
});

describe('G15 platform egress IPs', () => {
  it('RUNNER_PLATFORM_EGRESS_IPS (csv) or null', () => {
    expect(runnerSettings({}).platformEgressIps).toBeNull();
    expect(runnerSettings({ RUNNER_PLATFORM_EGRESS_IPS: ' 203.0.113.7 , 198.51.100.0/24,' }).platformEgressIps).toEqual(['203.0.113.7', '198.51.100.0/24']);
  });
});
