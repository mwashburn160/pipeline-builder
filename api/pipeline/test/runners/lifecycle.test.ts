// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dispatch (one delivery per job, the retry schedule, NOT_YET_VISIBLE, expiry,
 * per-pipeline serialization), terminal bookkeeping (audit, metrics, link
 * set/clear), runner health (3 delivery failures, 2 failed health pings or one
 * SIGNATURE_INVALID / RUNNER_REFUSED → unreachable + notices + pause; a pong
 * recovers it, says so and resumes) and the sweep.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import { processDelivery, runSweep } from '../../src/runners/lifecycle.js';
import { backoffMs } from '../../src/runners/vocabulary.js';
import { claimsOf, ORG, PIPE, reply, runnerRow, testDeps, URL_A, type TestDeps } from '../helpers/runner-fakes.js';

async function setup(action: 'start' | 'stop' = 'start', over: Partial<ReturnType<typeof runnerRow>> = {}) {
  const deps = testDeps();
  const runner = runnerRow(over);
  deps.store.runners.set(runner.id, runner);
  deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'acme-pipe', region: 'eu-west-1', runnerId: null });
  const req = await deps.store.insertRequest({
    orgId: ORG,
    pipelineId: PIPE,
    action,
    requestedBy: 'user-1',
    requestedAt: new Date(deps.clock.t),
    expiresAt: new Date(deps.clock.t + 600_000),
    runnerId: runner.id,
    ...(action === 'stop' ? { executionId: 'exec-1' } : {}),
  });
  return { deps, runner, req };
}

const TEAM = '0123456789abcdef0123456a';
const lastJws = (deps: TestDeps) => String(deps.fetchMock.mock.calls.at(-1)![1].body);

describe('backoffMs', () => {
  it('1, 2, 4, … capped at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(backoffMs(0)).toBe(1000);
  });
});

describe('processDelivery re-checks the runner\'s eligibility just before delivering', () => {
  const PARENT_ORG = '0123456789abcdef01234568';
  async function parentRunnerRequest(over: Partial<ReturnType<typeof runnerRow>> = {}) {
    const { deps, runner, req } = await setup('start', { orgId: PARENT_ORG, shareWithTeams: true, ...over });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'acme-pipe', region: 'eu-west-1', runnerId: runner.id, linkStatus: 'linked' });
    deps.ancestors.push(PARENT_ORG);
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'started', executionId: 'exec-1' }));
    return { deps, runner, req };
  }

  it('a parent\'s runner still shared with the team: delivered', async () => {
    const { deps, req } = await parentRunnerRequest();
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.fetchMock).toHaveBeenCalledTimes(1);
    expect(deps.store.requests.get(req.id)!.status).toBe('started');
  });

  it.each([
    ['un-shared since it was queued', (d: TestDeps, r: ReturnType<typeof runnerRow>) => { d.store.runners.set(r.id, { ...r, shareWithTeams: false }); }],
    ['the team moved under another parent', (d: TestDeps) => { d.ancestors.length = 0; d.ancestors.push('0123456789abcdef0123456f'); }],
  ])('%s: fails with RUNNER_NOT_ELIGIBLE, never delivered, and the stale link is cleared', async (_label, change) => {
    const { deps, runner, req } = await parentRunnerRequest();
    change(deps, runner);
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'failed', errorCode: 'RUNNER_NOT_ELIGIBLE' });
    expect(deps.store.registry.get(PIPE)!.runnerId).toBeNull();
    // The runner's health is untouched: nothing was sent.
    expect(deps.store.runners.get(runner.id)).toMatchObject({ health: 'healthy', consecutiveFailures: 0 });
  });

  it('the ancestry lookup failing keeps the request queued for a retry (never delivered, never failed)', async () => {
    const { deps, req } = await parentRunnerRequest();
    deps.hierarchy.ancestors = async (_o, _p, opts) => { if (opts?.strict) throw new Error('platform down'); return [PARENT_ORG]; };
    const out = await processDelivery(deps, req.id);
    expect(out.done).toBe(false);
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(deps.store.requests.get(req.id)!.status).toBe('queued');
  });

  it('the org\'s own runner needs no ancestry lookup', async () => {
    const { deps, req } = await setup();
    deps.hierarchy.ancestors = async () => { throw new Error('must not be asked'); };
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'started', executionId: 'exec-1' }));
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.store.requests.get(req.id)!.status).toBe('started');
  });
});

describe('processDelivery', () => {
  it('delivers a start (with the registry hint), finishes started, links the pipeline and audits without the URL', async () => {
    const { deps, runner, req } = await setup();
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'started', executionId: 'exec-9', runnerVersion: '1.4.0' }));
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(claimsOf(lastJws(deps))).toMatchObject({ action: 'start', pipelineId: PIPE, hint: { region: 'eu-west-1', pipelineName: 'acme-pipe' }, requestedBy: 'user-1', aud: runner.id, jti: req.id });
    const row = deps.store.requests.get(req.id)!;
    expect(row).toMatchObject({ status: 'started', resultExecutionId: 'exec-9', attempts: 1 });
    expect(deps.store.registry.get(PIPE)!.runnerId).toBe(runner.id);
    expect(deps.store.runners.get(runner.id)).toMatchObject({ version: '1.4.0', consecutiveFailures: 0 });
    const audit = deps.audits.find((a) => a.action === 'pipeline.execution.start')!;
    expect(audit).toMatchObject({ actorId: 'user-1', orgId: ORG, targetId: 'exec-9', details: { pipelineId: PIPE, requestId: req.id, runnerId: runner.id, attempts: 1, outcome: 'started' } });
    expect(audit).not.toHaveProperty('outcome');
    expect(JSON.stringify(deps.audits)).not.toContain(URL_A);
    expect(deps.counters).toContainEqual(['pipeline_runner_requests_total', { status: 'started' }]);
  });

  it('a stop carries the execution id and finishes stopped (audited as cancel)', async () => {
    const { deps, req } = await setup('stop');
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'stopped' }));
    await processDelivery(deps, req.id);
    expect(claimsOf(lastJws(deps))).toMatchObject({ action: 'stop', executionId: 'exec-1' });
    expect(deps.store.requests.get(req.id)!.status).toBe('stopped');
    expect(deps.audits[0]).toMatchObject({ action: 'pipeline.execution.cancel', targetId: 'exec-1' });
  });

  it('retries a timeout / 5xx / 429 on 1, 2, 4 … s, and expires it rather than deliver past its deadline', async () => {
    const { deps, req } = await setup();
    deps.fetchMock.mockResolvedValue(reply(503, {}));
    expect(await processDelivery(deps, req.id)).toEqual({ done: false, retryInMs: 1000 });
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'queued', lastDeliveryError: 'http_5xx' });
    deps.clock.t += 1000;
    deps.fetchMock.mockResolvedValue(reply(429, {}));
    expect(await processDelivery(deps, req.id)).toEqual({ done: false, retryInMs: 2000 });
    deps.clock.t += 2000;
    // (Health is not what this test is about: keep the runner under UNREACHABLE_AFTER_FAILURES.)
    deps.store.runners.set(req.runnerId!, { ...deps.store.runners.get(req.runnerId!)!, consecutiveFailures: 0 });
    deps.fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await processDelivery(deps, req.id)).toEqual({ done: false, retryInMs: 4000 });
    // Not yet due: the job waits out the remainder without delivering.
    const calls = deps.fetchMock.mock.calls.length;
    expect(await processDelivery(deps, req.id)).toEqual({ done: false, retryInMs: 4000 });
    expect(deps.fetchMock.mock.calls.length).toBe(calls);
    // Near the deadline the next retry would land past it → expired.
    deps.clock.t = deps.store.requests.get(req.id)!.expiresAt.getTime() - 500;
    deps.store.requests.set(req.id, { ...deps.store.requests.get(req.id)!, nextAttemptAt: null });
    await processDelivery(deps, req.id);
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'expired', errorCode: 'RUN_REQUEST_EXPIRED' });
    expect(deps.audits.at(-1)).toMatchObject({ outcome: 'failure', details: { outcome: 'expired', errorCode: 'RUN_REQUEST_EXPIRED' } });
  });

  it('never delivers an expired request', async () => {
    const { deps, req } = await setup();
    deps.clock.t += 600_001;
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(deps.store.requests.get(req.id)!.status).toBe('expired');
    // A finished request is a no-op.
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(await processDelivery(deps, 'nope')).toEqual({ done: true });
  });

  it('NOT_YET_VISIBLE retries every 15 s for at most 60 s, then fails with that code', async () => {
    const { deps, req } = await setup();
    deps.fetchMock.mockResolvedValue(reply(409, { errorCode: 'NOT_YET_VISIBLE' }));
    // Attempts at 0, 15, 30, 45 and 60 s; the one at 60 s ends the window.
    for (let i = 0; i < 4; i++) {
      expect(await processDelivery(deps, req.id)).toEqual({ done: false, retryInMs: 15_000 });
      deps.clock.t += 15_000;
    }
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'failed', errorCode: 'NOT_YET_VISIBLE' });
    // The runner answered every time: not a health failure.
    expect([...deps.store.runners.values()][0]!.consecutiveFailures).toBe(0);
  });

  it('a runner refusal fails the request with the runner\'s code; identity mismatch / untagged clear the link', async () => {
    for (const code of ['PIPELINE_IDENTITY_MISMATCH', 'PIPELINE_NOT_TAGGED']) {
      const { deps, runner, req } = await setup();
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: runner.id });
      deps.fetchMock.mockResolvedValue(reply(409, { errorCode: code }));
      await processDelivery(deps, req.id);
      expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'failed', errorCode: code });
      expect(deps.store.registry.get(PIPE)!.runnerId).toBeNull();
    }
    const { deps, runner, req } = await setup();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: runner.id });
    deps.fetchMock.mockResolvedValue(reply(403, { errorCode: 'RUNNER_REFUSED' }));
    await processDelivery(deps, req.id);
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'failed', errorCode: 'RUNNER_REFUSED' });
    expect(deps.store.registry.get(PIPE)!.runnerId).toBe(runner.id);
  });

  it('DUPLICATE (in flight at the runner) is retried, not failed', async () => {
    const { deps, req } = await setup();
    deps.fetchMock.mockResolvedValue(reply(409, { errorCode: 'DUPLICATE' }));
    expect(await processDelivery(deps, req.id)).toEqual({ done: false, retryInMs: 1000 });
    expect(deps.store.requests.get(req.id)!.status).toBe('queued');
  });

  it('serializes per pipeline: a busy pipeline waits 1 s', async () => {
    const { deps, req } = await setup();
    await deps.lock.acquire(PIPE, 30_000);
    expect(await processDelivery(deps, req.id)).toEqual({ done: false, retryInMs: 1000 });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('a revoked (or vanished) runner never gets the request', async () => {
    const { deps, runner, req } = await setup();
    deps.store.runners.set(runner.id, { ...runner, status: 'revoked' });
    await processDelivery(deps, req.id);
    expect(deps.store.requests.get(req.id)!.status).toBe('expired');
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });
});

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

describe('runner health', () => {
  it('3 consecutive transport failures (UNREACHABLE_AFTER_FAILURES) → unreachable, the org is notified, delivery pauses', async () => {
    const { deps, runner, req } = await setup();
    deps.fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    for (let i = 0; i < 2; i++) {
      const r = await processDelivery(deps, req.id);
      expect(r.done).toBe(false);
      deps.clock.t += 30_000;
    }
    expect(deps.store.runners.get(runner.id)).toMatchObject({ health: 'healthy', consecutiveFailures: 2 });
    expect(await processDelivery(deps, req.id)).toEqual({ done: true }); // paused, not rescheduled
    expect(deps.store.runners.get(runner.id)).toMatchObject({ health: 'unreachable', consecutiveFailures: 3 });
    expect(deps.notified).toEqual([expect.objectContaining({ recipientOrgId: ORG, subject: expect.stringContaining('unreachable'), priority: 'high' })]);
    expect(JSON.stringify(deps.notified)).not.toContain(URL_A);
    expect(deps.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.health', actorId: 'system', details: { from: 'healthy', to: 'unreachable' } }));
    // While unreachable, a job is a no-op (the request stays queued for the resume).
    deps.clock.t += 60_000;
    const calls = deps.fetchMock.mock.calls.length;
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.fetchMock.mock.calls.length).toBe(calls);
    expect(deps.store.requests.get(req.id)!.status).toBe('queued');
  });

  it('the sweep sends a signed ping to EVERY active runner once per RUNNER_HEALTH_PING_INTERVAL_SECONDS', async () => {
    const { deps, runner } = await setup();
    const other = runnerRow({ label: 'other' });
    deps.store.runners.set(other.id, other);
    deps.store.runners.set('pending', runnerRow({ id: 'pending', status: 'pending', functionUrl: null }));
    expect((await runSweep(deps)).pinged).toBe(2);
    const pings = deps.fetchMock.mock.calls.map(([, o]) => claimsOf(String(o.body)));
    expect(pings.map((c) => c.aud).sort()).toEqual([runner.id, other.id].sort());
    expect(pings[0]).toMatchObject({ action: 'ping', requestedBy: 'system:runner-ping' });
    expect(pings[0]).not.toHaveProperty('pipelineId');
    deps.clock.t += 30_000;
    expect((await runSweep(deps)).pinged).toBe(0); // inside the 60 s interval
    deps.clock.t += 30_000;
    expect((await runSweep(deps)).pinged).toBe(2);
    process.env.RUNNER_HEALTH_PING_INTERVAL_SECONDS = '120';
    deps.clock.t += 60_000;
    expect((await runSweep(deps)).pinged).toBe(0);
  });

  it('2 failed pings in a row (RUNNER_UNHEALTHY_AFTER_PINGS) mark a runner unhealthy and send the notice to its org and the teams using it', async () => {
    const { deps, runner } = await setup();
    // A team pipeline linked to this (shared) runner: that team's admins hear too.
    deps.store.registry.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { orgId: TEAM, pipelineName: 't', region: null, runnerId: runner.id });
    deps.fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await runSweep(deps)).toMatchObject({ pinged: 1, markedUnhealthy: 0 });
    expect(deps.store.runners.get(runner.id)!.health).toBe('healthy');
    deps.clock.t += 60_000;
    expect(await runSweep(deps)).toMatchObject({ pinged: 1, markedUnhealthy: 1 });
    expect(deps.store.runners.get(runner.id)!.health).toBe('unreachable');
    expect(deps.notified.map((n) => (n as { recipientOrgId: string }).recipientOrgId)).toEqual([ORG, TEAM]);
    expect(deps.notified[0]).toMatchObject({ subject: expect.stringContaining('unreachable'), content: expect.stringContaining('failed 2 health pings'), priority: 'high' });
    expect(deps.gauges.at(-1)).toEqual(['pipeline_runners_unhealthy', 1]);
  });

  it('a success between failed pings resets the count; RUNNER_UNHEALTHY_AFTER_PINGS is configurable', async () => {
    process.env.RUNNER_UNHEALTHY_AFTER_PINGS = '3';
    const { deps, runner } = await setup();
    const sweepWith = async (ok: boolean) => {
      if (ok) deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'pong' })); else deps.fetchMock.mockRejectedValueOnce(new Error('timeout'));
      await runSweep(deps);
      deps.clock.t += 60_000;
    };
    await sweepWith(false); await sweepWith(false); await sweepWith(true); await sweepWith(false); await sweepWith(false);
    expect(deps.store.runners.get(runner.id)!.health).toBe('healthy');
    await sweepWith(false);
    expect(deps.store.runners.get(runner.id)!.health).toBe('unreachable');
  });

  it.each(['SIGNATURE_INVALID', 'RUNNER_REFUSED'])('a %s ping reply marks the runner unhealthy at once (a key or configuration problem)', async (code) => {
    const { deps, runner } = await setup();
    deps.fetchMock.mockResolvedValue(reply(code === 'SIGNATURE_INVALID' ? 401 : 403, { errorCode: code }));
    expect(await runSweep(deps)).toMatchObject({ pinged: 1, markedUnhealthy: 1 });
    expect(deps.store.runners.get(runner.id)!.health).toBe('unreachable');
    expect(deps.notified).toEqual([expect.objectContaining({ recipientOrgId: ORG, content: expect.stringContaining(code) })]);
  });

  it('a ping the platform could not sign (the org\'s key is missing) never counts against the runner', async () => {
    const { deps, runner } = await setup();
    deps.signerFor = async () => { throw Object.assign(new Error('no key'), { code: 'RUNNER_KEY_MISSING' }); };
    for (let i = 0; i < 3; i++) { await runSweep(deps); deps.clock.t += 60_000; }
    expect(deps.store.runners.get(runner.id)!.health).toBe('healthy');
    expect(deps.notified).toEqual([]);
  });

  it('recovery: a pong recovers an unreachable runner, sends the recovery notice and resumes its queued runs', async () => {
    const { deps, runner, req } = await setup('start', { health: 'unreachable', consecutiveFailures: 3 });
    deps.fetchMock.mockRejectedValueOnce(new Error('timeout'));
    expect(await runSweep(deps)).toMatchObject({ pinged: 1, recovered: 0 });
    expect(deps.notified).toEqual([]); // still down: no second notice
    deps.clock.t += 60_000;
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'pong' }));
    expect(await runSweep(deps)).toMatchObject({ pinged: 1, recovered: 1 });
    expect(claimsOf(lastJws(deps))).toMatchObject({ action: 'ping', requestedBy: 'system:runner-ping', aud: runner.id });
    expect(deps.store.runners.get(runner.id)).toMatchObject({ health: 'healthy', consecutiveFailures: 0 });
    expect(deps.enqueued.map((e) => e.requestId)).toContain(req.id);
    expect(deps.notified).toEqual([expect.objectContaining({ recipientOrgId: ORG, subject: expect.stringContaining('reachable again'), priority: 'normal' })]);
    expect(deps.gauges.at(-1)).toEqual(['pipeline_runners_unhealthy', 0]);
  });

  it('the sweep expires undelivered requests past their 10 minutes and publishes the unhealthy gauge', async () => {
    const { deps, req } = await setup();
    deps.clock.t += 600_000;
    expect((await runSweep(deps)).expired).toBe(1);
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'expired', errorCode: 'RUN_REQUEST_EXPIRED' });
    expect(deps.counters).toContainEqual(['pipeline_runner_requests_total', { status: 'expired' }]);
    expect(deps.gauges).toContainEqual(['pipeline_runners_unhealthy', 0]);
  });
});
