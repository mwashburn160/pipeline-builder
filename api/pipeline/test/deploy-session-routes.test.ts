// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy job's facade routes over the in-memory runner doubles: the
 * registry post registers exactly the session's deploy (org, pipeline, runner
 * from the session), with the org's root for a team (its root org's installs
 * apply to the manifest, as on the user registry route).
 */

import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn<AnyFn>();
const mockCallInternal = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  callInternal: (...a: unknown[]) => mockCallInternal(...a),
  serviceEndpoint: () => ({}),
  InternalHttpClient: class {},
  getParam: (p: Record<string, string>, k: string) => p[k],
}));
jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({ pipelineService: { findById: jest.fn() } }));

const { createDeploySessionRoutes } = await import('../src/routes/deploy-session-routes.js');
const { setRunnerDepsForTesting } = await import('../src/runners/deps.js');
const { startDeploy } = await import('../src/runners/deploy-routing.js');
const { processDelivery } = await import('../src/runners/lifecycle.js');
const { exchangeDeployGrant } = await import('../src/runners/deploy-grants.js');
const { DEPLOY_JOB_PROTOCOL_VERSION, deployProjectName } = await import('@pipeline-builder/api-core/pipeline-runners');
const { claimsOf, ORG, PARENT, PIPE, reply, runnerRow, testDeps } = await import('./helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
const router = createDeploySessionRoutes() as any;
const stackOf = (method: string, path: string) => router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]).route.stack.map((s: any) => s.handle);

function res() {
  const r: any = { statusCode: 0, body: undefined as any, headersSent: false };
  r.status = jest.fn((c: number) => { r.statusCode = c; return r; });
  r.json = jest.fn((b: unknown) => { r.body = b; r.headersSent = true; return r; });
  r.setHeader = jest.fn();
  return r;
}

/** Run a route's whole middleware chain (limiter, session gate, handler). */
async function call(method: string, path: string, req: Record<string, unknown>) {
  const r = res();
  const request = { ip: '10.0.0.1', headers: {}, ...req };
  for (const fn of stackOf(method, path)) {
    let nextCalled = false;
    await fn(request, r, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return r;
}

let deps: Deps;
beforeEach(() => {
  jest.clearAllMocks();
  deps = testDeps();
  setRunnerDepsForTesting(deps);
});
afterEach(() => { setRunnerDepsForTesting(null); });

/** A team's deploy through its own runner, accepted and with the job's session. */
async function liveSession() {
  const runner = runnerRow({ capabilities: ['deploy:1'], pipelinePrefixes: ['*'], regions: ['us-east-1'] });
  deps.store.runners.set(runner.id, runner);
  const queued = await startDeploy(deps, {
    pipelineId: PIPE,
    orgId: ORG,
    pipelineName: 'acme-shop-pipeline',
    stackName: 'shop-acme',
    registered: false,
    toolchain: { releaseVersion: '1.2.0', imageDigest: `sha256:${'a'.repeat(64)}`, deployJobProtocol: DEPLOY_JOB_PROTOCOL_VERSION },
  }, {}, 'user-1');
  deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploying', buildId: `${deployProjectName(runner.id)}:0f8fad5b-d9cb-469f-a165-70867728950e` }) as never);
  await processDelivery(deps, queued.requestId);
  const grant = (claimsOf(String(deps.fetchMock.mock.calls.at(-1)![1].body)).deploy as { grant: string }).grant;
  const { sessionToken } = await exchangeDeployGrant(deps, queued.requestId, grant);
  return { requestId: queued.requestId, runner, sessionToken };
}

describe('POST /deploys/:requestId/registry', () => {
  it("registers the session's own deploy; a team's manifest is read with its root org's installs", async () => {
    const { requestId, runner, sessionToken } = await liveSession();
    deps.ancestors.push(PARENT);
    const r = await call('post', '/deploys/:requestId/registry', {
      params: { requestId },
      headers: { authorization: `Bearer ${sessionToken}` },
      body: { pipelineName: 'acme-shop-pipeline', stackName: 'shop-acme', region: 'us-east-1', steps: [] },
    });
    expect(r.statusCode).toBe(200);
    const calls = (deps.registry as unknown as { calls: Array<Record<string, unknown>> }).calls;
    expect(calls.at(-1)).toMatchObject({ pipelineId: PIPE, orgId: ORG, runnerId: runner.id, parentOrgId: PARENT, steps: [] });
  });

  it('a root org registers with no parent; a mismatched target is refused', async () => {
    const { requestId, sessionToken } = await liveSession();
    const ok = await call('post', '/deploys/:requestId/registry', {
      params: { requestId },
      headers: { authorization: `Bearer ${sessionToken}` },
      body: { pipelineName: 'acme-shop-pipeline', stackName: 'shop-acme', region: 'us-east-1' },
    });
    expect(ok.statusCode).toBe(200);
    const calls = (deps.registry as unknown as { calls: Array<Record<string, unknown>> }).calls;
    expect(calls.at(-1)).not.toHaveProperty('parentOrgId');
    const bad = await call('post', '/deploys/:requestId/registry', {
      params: { requestId },
      headers: { authorization: `Bearer ${sessionToken}` },
      body: { pipelineName: 'acme-shop-pipeline', stackName: 'other', region: 'us-east-1' },
    });
    expect([bad.statusCode, bad.body?.code]).toEqual([409, 'DEPLOY_TARGET_MISMATCH']);
  });
});

describe('POST /deploys/:requestId/plugin-lookup', () => {
  it("looks up as the session's org; a failed call answers 502 without the platform's internal address", async () => {
    const { requestId, sessionToken } = await liveSession();
    mockCallInternal.mockRejectedValueOnce(new Error('connect ECONNREFUSED http://plugin.internal:3000/internal/plugins/orgs/x/lookup'));
    const r = await call('post', '/deploys/:requestId/plugin-lookup', {
      params: { requestId }, headers: { authorization: `Bearer ${sessionToken}` }, body: { filter: { name: 'node' } },
    });
    expect(r.statusCode).toBe(502);
    expect(mockCallInternal.mock.calls[0]![2]).toMatchObject({ params: { orgId: ORG } });
    expect(JSON.stringify(r.body)).not.toMatch(/plugin\.internal|ECONNREFUSED|http/);
  });

  it("a context naming another pipeline is refused 400 and never reaches the plugin service; the session's own (any case) or none passes", async () => {
    const { requestId, sessionToken } = await liveSession();
    const lookup = (body: Record<string, unknown>) => call('post', '/deploys/:requestId/plugin-lookup', {
      params: { requestId }, headers: { authorization: `Bearer ${sessionToken}` }, body,
    });
    const other = await lookup({ filter: { name: 'node' }, context: { pipelineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } });
    expect([other.statusCode, other.body?.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(mockCallInternal).not.toHaveBeenCalled();

    mockCallInternal.mockResolvedValue({ ok: true, status: 200, body: { success: true, data: { plugin: {}, warnings: [] } } });
    const same = await lookup({ filter: { name: 'node' }, context: { pipelineId: PIPE.toUpperCase() } });
    expect(same.statusCode).toBe(200);
    const none = await lookup({ filter: { name: 'node' } });
    expect(none.statusCode).toBe(200);
    expect(mockCallInternal).toHaveBeenCalledTimes(2);
  });
});

describe('every facade route answers 401 once the session is gone (the job stops on it)', () => {
  const ROUTES: Array<[string, string, Record<string, unknown>]> = [
    ['get', '/deploys/:requestId/pipeline', {}],
    ['post', '/deploys/:requestId/plugin-lookup', { filter: { name: 'node' } }],
    ['post', '/deploys/:requestId/progress', { stage: 'synthesizing' }],
    ['post', '/deploys/:requestId/registry', { pipelineName: 'acme-shop-pipeline', stackName: 'shop-acme', region: 'us-east-1' }],
    ['post', '/deploys/:requestId/result', { code: 'OK' }],
  ];
  const each = async (requestId: string, authorization: string) => Promise.all(ROUTES.map(async ([m, path, body]) => {
    const r = await call(m, path, { params: { requestId }, headers: { authorization }, body });
    return [path, r.statusCode, r.body?.code];
  }));
  const all401 = (path: string) => [path, 401, 'DEPLOY_GRANT_INVALID'];

  it('a terminal deploy (session wiped), an unknown token and an expired session are 401 DEPLOY_GRANT_INVALID on every route', async () => {
    const { requestId, sessionToken } = await liveSession();
    // Unknown token.
    expect(await each(requestId, `Bearer pb_ds_${'x'.repeat(43)}`)).toEqual(ROUTES.map(([, p]) => all401(p)));
    // Expired session (past the deploy deadline).
    deps.clock.t += 24 * 60 * 60_000;
    expect(await each(requestId, `Bearer ${sessionToken}`)).toEqual(ROUTES.map(([, p]) => all401(p)));
    deps.clock.t -= 24 * 60 * 60_000;
    // Terminal: the deploy finished, its session wiped.
    const { finishRequest } = await import('../src/runners/lifecycle.js');
    await finishRequest(deps, deps.store.requests.get(requestId)!, 'cancelled', { errorCode: 'DEPLOY_CANCELLED' });
    expect(await each(requestId, `Bearer ${sessionToken}`)).toEqual(ROUTES.map(([, p]) => all401(p)));
    expect(mockCallInternal).not.toHaveBeenCalled();
  });

  it('the grant exchange refuses a used or unknown grant with 401 DEPLOY_GRANT_INVALID too', async () => {
    const { requestId } = await liveSession();
    const grant = (claimsOf(String(deps.fetchMock.mock.calls.at(-1)![1].body)).deploy as { grant: string }).grant;
    const used = await call('post', '/deploys/:requestId/session', { params: { requestId }, body: { grant } });
    const unknown = await call('post', '/deploys/:requestId/session', { params: { requestId }, body: { grant: `pb_dg_${'y'.repeat(43)}` } });
    expect([used.statusCode, used.body?.code, unknown.statusCode, unknown.body?.code]).toEqual([401, 'DEPLOY_GRANT_INVALID', 401, 'DEPLOY_GRANT_INVALID']);
  });
});

