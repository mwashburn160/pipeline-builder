// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Register (URL check + signed ping), update, test, revoke and list. */

import { describe, expect, it } from '@jest/globals';
import { listRunners, registerRunner, revokeRunner, runnerDto, testRunner, updateRunner } from '../../src/runners/admin.js';
import { claimsOf, ORG, PARENT, PIPE, reply, runnerRow, testDeps, URL_A } from '../helpers/runner-fakes.js';

async function refusal(p: Promise<unknown>) {
  try { await p; } catch (err) { return err as { status: number; code: string; message: string }; }
  throw new Error('expected a refusal');
}

describe('registerRunner', () => {
  it('pings the URL (aud = the NEW runner id) and stores the runner only after a pong', async () => {
    const deps = testDeps();
    const runner = await registerRunner(deps, ORG, 'user-1', { label: 'prod', functionUrl: URL_A });
    const ping = claimsOf(String(deps.fetchMock.mock.calls[0]![1].body));
    expect(ping).toMatchObject({ action: 'ping', aud: runner.id, requestedBy: 'user-1' });
    expect(ping).not.toHaveProperty('pipelineId');
    expect(deps.fetchMock.mock.calls).toHaveLength(1); // a ping, nothing else
    expect(runner).toMatchObject({ orgId: ORG, label: 'prod', functionUrl: URL_A, version: '1.2.3', regions: ['us-east-1'], health: 'healthy', status: 'active', createdBy: 'user-1' });
    expect(deps.store.runners.get(runner.id)).toBeDefined();
  });

  it('prefers the regions the admin named', async () => {
    const deps = testDeps();
    expect((await registerRunner(deps, ORG, 'u', { label: 'x', functionUrl: URL_A, regions: ['eu-west-1'] })).regions).toEqual(['eu-west-1']);
  });

  it('refuses a URL outside the allowlist without sending anything (SSRF)', async () => {
    const deps = testDeps();
    for (const url of ['https://169.254.169.254/', 'http://abc.lambda-url.us-east-1.on.aws/', 'https://internal.svc.cluster.local/']) {
      expect(await refusal(registerRunner(deps, ORG, 'u', { label: 'x', functionUrl: url }))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    }
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(deps.store.runners.size).toBe(0);
  });

  it('refuses when the ping fails (no answer, an SSRF-refused resolution, a non-pong) and stores nothing', async () => {
    const deps = testDeps();
    deps.fetchMock.mockRejectedValueOnce(new Error('URL resolves to a private address'));
    const e1 = await refusal(registerRunner(deps, ORG, 'u', { label: 'x', functionUrl: URL_A }));
    expect(e1).toMatchObject({ status: 422, code: 'RUNNER_PING_FAILED' });
    expect(e1.message).not.toContain(URL_A);
    deps.fetchMock.mockResolvedValueOnce(reply(401, { errorCode: 'SIGNATURE_INVALID' }));
    expect(await refusal(registerRunner(deps, ORG, 'u', { label: 'x', functionUrl: URL_A }))).toMatchObject({ code: 'RUNNER_PING_FAILED', message: expect.stringContaining('SIGNATURE_INVALID') });
    deps.fetchMock.mockResolvedValueOnce(reply(409, { errorCode: 'NOT_YET_VISIBLE' }));
    expect(await refusal(registerRunner(deps, ORG, 'u', { label: 'x', functionUrl: URL_A }))).toMatchObject({ code: 'RUNNER_PING_FAILED' });
    expect(deps.store.runners.size).toBe(0);
  });

  it('caps runners per org', async () => {
    const deps = testDeps();
    for (let i = 0; i < 20; i++) { const r = runnerRow(); deps.store.runners.set(r.id, r); }
    expect(await refusal(registerRunner(deps, ORG, 'u', { label: 'x', functionUrl: URL_A }))).toMatchObject({ status: 409, code: 'RUNNER_LIMIT' });
  });
});

describe('updateRunner', () => {
  it('renames / re-shares without a ping; a new URL is re-pinged', async () => {
    const deps = testDeps();
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    const out = await updateRunner(deps, ORG, 'u', r.id, { label: 'renamed', shareWithTeams: false });
    expect(out.changed).toEqual(['label', 'shareWithTeams']);
    expect(deps.fetchMock).not.toHaveBeenCalled();
    const next = 'https://zzz999.lambda-url.us-west-2.on.aws/';
    const moved = await updateRunner(deps, ORG, 'u', r.id, { functionUrl: next });
    expect(moved.changed).toEqual(['functionUrl']);
    expect(deps.fetchMock.mock.calls[0]![0]).toBe(next);
    expect(moved.runner.functionUrl).toBe(next);
    expect((await updateRunner(deps, ORG, 'u', r.id, { label: 'renamed' })).changed).toEqual([]);
  });

  it('a new URL that does not pong, or is outside the allowlist, is refused and nothing changes', async () => {
    const deps = testDeps();
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    deps.fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await refusal(updateRunner(deps, ORG, 'u', r.id, { functionUrl: 'https://new111.lambda-url.us-east-1.on.aws/' }))).toMatchObject({ code: 'RUNNER_PING_FAILED' });
    expect(await refusal(updateRunner(deps, ORG, 'u', r.id, { functionUrl: 'https://evil.com/' }))).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(deps.store.runners.get(r.id)!.functionUrl).toBe(URL_A);
  });

  it('another org\'s (or an inherited) runner is not found; a revoked one is refused', async () => {
    const deps = testDeps();
    const other = runnerRow({ orgId: PARENT }); deps.store.runners.set(other.id, other);
    expect(await refusal(updateRunner(deps, ORG, 'u', other.id, { label: 'x' }))).toMatchObject({ status: 404 });
    expect(await refusal(updateRunner(deps, ORG, 'u', 'not-a-uuid', { label: 'x' }))).toMatchObject({ status: 404 });
    const gone = runnerRow({ status: 'revoked' }); deps.store.runners.set(gone.id, gone);
    expect(await refusal(updateRunner(deps, ORG, 'u', gone.id, { label: 'x' }))).toMatchObject({ status: 409, code: 'RUNNER_REVOKED' });
    expect(await refusal(testRunner(deps, ORG, 'u', gone.id))).toMatchObject({ code: 'RUNNER_REVOKED' });
  });
});

describe('testRunner', () => {
  it('a pong → ok, the runner is healthy again and its paused requests resume', async () => {
    const deps = testDeps();
    const r = runnerRow({ health: 'unreachable', consecutiveFailures: 5 }); deps.store.runners.set(r.id, r);
    const q = await deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', expiresAt: new Date(deps.clock.t + 1e5), runnerId: r.id });
    expect(await testRunner(deps, ORG, 'u', r.id)).toEqual({ ok: true, outcome: 'pong' });
    expect(claimsOf(String(deps.fetchMock.mock.calls[0]![1].body))).toMatchObject({ action: 'ping', aud: r.id });
    expect(deps.store.runners.get(r.id)).toMatchObject({ health: 'healthy', consecutiveFailures: 0 });
    expect(deps.enqueued).toEqual([{ requestId: q.id }]);
  });

  it('no answer → ok: false with the code (and a health strike); a refusal → its code', async () => {
    const deps = testDeps();
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    deps.fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    expect(await testRunner(deps, ORG, 'u', r.id)).toEqual({ ok: false, errorCode: 'conn_refused' });
    expect(deps.store.runners.get(r.id)!.consecutiveFailures).toBe(1);
    deps.fetchMock.mockResolvedValueOnce(reply(401, { errorCode: 'SIGNATURE_INVALID' }));
    expect(await testRunner(deps, ORG, 'u', r.id)).toEqual({ ok: false, errorCode: 'SIGNATURE_INVALID' });
    deps.fetchMock.mockResolvedValueOnce(reply(409, { errorCode: 'NOT_YET_VISIBLE' }));
    expect(await testRunner(deps, ORG, 'u', r.id)).toEqual({ ok: false, errorCode: 'NOT_YET_VISIBLE' });
  });
});

describe('testRunner — a runner that is gone', () => {
  it('an "immediate" transport failure (NXDOMAIN, AWS\'s URL-gone 403) marks it unreachable at once, as delivery does', async () => {
    const deps = testDeps();
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    deps.fetchMock.mockResolvedValueOnce(reply(403, { Message: 'Forbidden' }));
    expect(await testRunner(deps, ORG, 'u', r.id)).toEqual({ ok: false, errorCode: 'aws_403_url_gone' });
    expect(deps.store.runners.get(r.id)).toMatchObject({ health: 'unreachable', consecutiveFailures: 1 });
  });
});

describe('revokeRunner', () => {
  it('revokes, clears every pipeline link and expires pending requests (idempotent)', async () => {
    const deps = testDeps();
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r.id });
    const q = await deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', expiresAt: new Date(deps.clock.t + 1e5), runnerId: r.id });
    const out = await revokeRunner(deps, ORG, r.id);
    expect(out).toMatchObject({ linksCleared: 1, requestsExpired: 1, runner: { status: 'revoked' } });
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: null, linkStatus: 'unlinked' });
    expect(deps.store.requests.get(q.id)).toMatchObject({ status: 'expired', errorCode: 'RUNNER_REVOKED' });
    expect(await revokeRunner(deps, ORG, r.id)).toMatchObject({ linksCleared: 0, requestsExpired: 0 });
  });
});

describe('listRunners / runnerDto', () => {
  it('own runners carry their URL; inherited ones never do, and name their org', async () => {
    const deps = testDeps();
    deps.ancestors.push(PARENT);
    const own = runnerRow({ label: 'own' }); deps.store.runners.set(own.id, own);
    const inh = runnerRow({ orgId: PARENT, label: 'parent' }); deps.store.runners.set(inh.id, inh);
    const hidden = runnerRow({ orgId: PARENT, shareWithTeams: false }); deps.store.runners.set(hidden.id, hidden);
    const { own: o, inherited } = await listRunners(deps, ORG);
    expect(o).toEqual([expect.objectContaining({ id: own.id, functionUrl: URL_A })]);
    expect(inherited).toEqual([expect.objectContaining({ id: inh.id, functionUrl: null, fromOrgId: PARENT, fromOrgName: expect.any(String) })]);
    expect(Object.keys(runnerDto(own, ORG)).sort()).toEqual(['capabilities', 'createdAt', 'functionUrl', 'health', 'id', 'jwksUrl', 'label', 'lastDeliveryAt', 'orgId', 'pipelineCount', 'pipelinePrefixes', 'regions', 'shareDeploysWithTeams', 'shareWithTeams', 'status', 'updateRequired', 'version'].sort());
  });

  it('each runner carries its pipelineCount (the pipelines linked to it) and its own JWKS URL', async () => {
    const saved = process.env.PLATFORM_BASE_URL;
    process.env.PLATFORM_BASE_URL = 'https://platform.example.com/';
    try {
      const deps = testDeps();
      const own = runnerRow({ label: 'own' }); deps.store.runners.set(own.id, own);
      const idle = runnerRow({ label: 'idle' }); deps.store.runners.set(idle.id, idle);
      deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'a', region: null, runnerId: own.id });
      deps.store.registry.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { orgId: ORG, pipelineName: 'b', region: null, runnerId: own.id });
      const { own: list } = await listRunners(deps, ORG);
      expect(list.map((r) => [r.label, r.pipelineCount])).toEqual([['own', 2], ['idle', 0]]);
      expect(list[0]!.jwksUrl).toBe(`https://platform.example.com/api/pipelines/runner/runners/${own.id}/jwks.json`);
    } finally {
      if (saved === undefined) delete process.env.PLATFORM_BASE_URL; else process.env.PLATFORM_BASE_URL = saved;
    }
  });

  it('no ancestors → no names lookup', async () => {
    const deps = testDeps();
    expect(await listRunners(deps, ORG)).toEqual({ own: [], inherited: [] });
  });
});
