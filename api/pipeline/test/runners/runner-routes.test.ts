// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner HTTP routes' handlers with the real api-core envelope helpers and
 * an injected runner dependency bundle (no network, no database): response
 * shapes, RUNNERS_UNAVAILABLE, audits (never the Function URL), JWKS.
 */

import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { routeHandler, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from '../helpers/mock-api-core.js';

const mockAudit = jest.fn<(e: Record<string, unknown>) => void>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: mockAudit }));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  createAuthenticatedWithOrgRoute: () => [],
  rateLimitByOrg: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  incCounter: () => undefined,
  setGauge: () => undefined,
  withRoute: (handler: (a: unknown) => Promise<unknown>) => async (req: { user?: Record<string, unknown> }, response: unknown) =>
    handler({ req, res: response, ctx: { log: () => undefined }, orgId: String(req.user?.organizationId ?? ''), userId: String(req.user?.sub ?? '') }),
}));

const { createRunnerJwksRoutes, createRunnerRoutes, jwksUrl, requireRunnersAvailable } = await import('../../src/routes/runner-routes.js');
const { setRunnerDepsForTesting } = await import('../../src/runners/deps.js');
const { resetRunRequestCachesForTesting } = await import('../../src/runners/run-request-status.js');
const { ORG, PARENT, PIPE, reply, runnerRow, testDeps, URL_A } = await import('../helpers/runner-fakes.js');

function res() {
  const r: { statusCode?: number; body?: any; headers: Record<string, string>; status: (n: number) => unknown; json: (b: unknown) => unknown; setHeader: (k: string, v: string) => void } = {
    headers: {},
    status(n) { r.statusCode = n; return r; },
    json(b) { r.body = b; return r; },
    setHeader(k, v) { r.headers[k] = v; },
  };
  return r;
}
const user = { sub: 'user-1', organizationId: ORG, features: ['cross_account_runners'] };
const router = createRunnerRoutes();
const call = async (method: string, path: string, req: Record<string, unknown> = {}) => {
  const r = res();
  await routeHandler(router, method, path)({ user, params: {}, query: {}, body: {}, headers: {}, ...req }, r);
  return r;
};

let deps: ReturnType<typeof testDeps>;
beforeEach(() => {
  mockAudit.mockReset();
  deps = testDeps();
  setRunnerDepsForTesting(deps);
  resetRunRequestCachesForTesting();
});
afterEach(() => { setRunnerDepsForTesting(null); });

describe('unavailable (feature off / no key)', () => {
  it('no signing key: GET answers available:false (no store touched); writes and JWKS answer 409 RUNNERS_UNAVAILABLE', async () => {
    setRunnerDepsForTesting({ signer: () => null });
    const list = await call('get', '/runners');
    expect(list.body.data).toEqual({ available: false, jwksUrl: expect.stringContaining('/api/pipelines/runner/jwks.json'), platformEgressIps: null, own: [], inherited: [] });
    const gate = res();
    const next = jest.fn();
    await requireRunnersAvailable({} as never, gate as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(gate.statusCode).toBe(409);
    expect(gate.body).toMatchObject({ code: 'RUNNERS_UNAVAILABLE' });
    const j = res();
    await routeHandler(createRunnerJwksRoutes(), 'get', '/jwks.json')({}, j);
    expect(j.statusCode).toBe(409);
    // The run-request read is a 404 when runners are off.
    expect((await call('get', '/:pipelineId/run-requests/:requestId', { params: { pipelineId: PIPE, requestId: '00000000-0000-4000-8000-000000000001' } })).statusCode).toBe(404);
  });

  it('the gate passes when available', async () => {
    const next = jest.fn();
    await requireRunnersAvailable({} as never, res() as never, next);
    expect(next).toHaveBeenCalled();
  });

  it('a database without the runner tables: writes answer 409 RUNNERS_UNAVAILABLE naming the missing tables; GET is available:false; no 500', async () => {
    deps.store.tablesPresent = async () => false;
    const gate = res();
    const next = jest.fn();
    await requireRunnersAvailable({} as never, gate as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(gate.statusCode).toBe(409);
    expect(gate.body).toMatchObject({ code: 'RUNNERS_UNAVAILABLE', message: expect.stringMatching(/runner tables/) });
    deps.store.listRunners = async () => { throw new Error('relation "pipeline_runners" does not exist'); };
    const list = await call('get', '/runners');
    expect(list.statusCode).toBe(200);
    expect(list.body.data).toMatchObject({ available: false, own: [], inherited: [] });
    expect((await call('get', '/:pipelineId/run-requests/:requestId', { params: { pipelineId: PIPE, requestId: '00000000-0000-4000-8000-000000000001' } })).statusCode).toBe(404);
  });
});

describe('GET /pipelines/runner/jwks.json', () => {
  it('serves the bare JWK set (RFC 7517), cacheable', async () => {
    const r = res();
    await routeHandler(createRunnerJwksRoutes(), 'get', '/jwks.json')({}, r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: expect.any(String), kid: expect.any(String), use: 'sig', alg: 'EdDSA' }] });
    expect(r.headers['Cache-Control']).toBe('public, max-age=300');
  });

  it('jwksUrl is built on PLATFORM_BASE_URL', () => {
    expect(jwksUrl({ PLATFORM_BASE_URL: 'https://pb.example.com/' })).toBe('https://pb.example.com/api/pipelines/runner/jwks.json');
    expect(jwksUrl({})).toBe('/api/pipelines/runner/jwks.json');
  });
});

describe('runner admin', () => {
  it('GET lists own + inherited with platformEgressIps', async () => {
    process.env.RUNNER_PLATFORM_EGRESS_IPS = '203.0.113.7';
    try {
      deps.ancestors.push(PARENT);
      const own = runnerRow(); deps.store.runners.set(own.id, own);
      const inh = runnerRow({ orgId: PARENT }); deps.store.runners.set(inh.id, inh);
      const r = await call('get', '/runners', { user: { ...user, parentOrganizationId: PARENT } });
      expect(r.body.data).toMatchObject({ available: true, platformEgressIps: ['203.0.113.7'], own: [{ id: own.id, functionUrl: URL_A }], inherited: [{ id: inh.id, functionUrl: null, fromOrgId: PARENT }] });
    } finally {
      delete process.env.RUNNER_PLATFORM_EGRESS_IPS;
    }
  });

  it('POST registers (pending without a URL; active after a pong with one) → 201 { runner }, audited without the URL', async () => {
    const pending = await call('post', '/runners', { body: { label: 'new' } });
    expect(pending.statusCode).toBe(201);
    expect(pending.body.data.runner).toMatchObject({ status: 'pending', functionUrl: null, label: 'new' });
    const active = await call('post', '/runners', { body: { label: 'prod', functionUrl: URL_A, regions: ['us-east-1'] } });
    expect(active.statusCode).toBe(201);
    expect(active.body.data.runner).toMatchObject({ status: 'active', functionUrl: URL_A });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline.runner.register', targetId: active.body.data.runner.id }));
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(URL_A);
  });

  it('POST validation and refusals', async () => {
    expect((await call('post', '/runners', { body: { label: '' } })).statusCode).toBe(400);
    expect((await call('post', '/runners', { body: { label: 'x', extra: 1 } })).statusCode).toBe(400);
    const bad = await call('post', '/runners', { body: { label: 'x', functionUrl: 'https://169.254.169.254/' } });
    expect(bad.statusCode).toBe(400);
    deps.fetchMock.mockResolvedValue(reply(401, { errorCode: 'SIGNATURE_INVALID' }));
    const ping = await call('post', '/runners', { body: { label: 'x', functionUrl: URL_A } });
    expect(ping.statusCode).toBe(422);
    expect(ping.body).toMatchObject({ code: 'RUNNER_PING_FAILED', details: { runnerLabel: 'x' } });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline.runner.register', outcome: 'failure', details: { label: 'x', reason: 'RUNNER_PING_FAILED' } }));
  });

  it('PATCH → 200 { runner }; audits which fields changed, never the URL; unknown → 404', async () => {
    const r0 = runnerRow(); deps.store.runners.set(r0.id, r0);
    const r = await call('patch', '/runners/:id', { params: { id: r0.id }, body: { label: 'renamed', functionUrl: 'https://new123.lambda-url.us-west-2.on.aws/' } });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.runner).toMatchObject({ label: 'renamed' });
    const audit = mockAudit.mock.calls.at(-1)![0];
    expect(audit).toMatchObject({ action: 'pipeline.runner.update', details: { changed: ['label', 'functionUrl'] } });
    expect(JSON.stringify(audit)).not.toContain('new123');
    expect((await call('patch', '/runners/:id', { params: { id: r0.id }, body: { bogus: 1 } })).statusCode).toBe(400);
    expect((await call('patch', '/runners/:id', { params: { id: '00000000-0000-4000-8000-00000000ffff' }, body: { label: 'x' } })).statusCode).toBe(404);
    // No change → no audit row.
    mockAudit.mockReset();
    expect((await call('patch', '/runners/:id', { params: { id: r0.id }, body: { label: 'renamed' } })).statusCode).toBe(200);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('POST /:id/test → { ok, outcome } / { ok: false, errorCode }, audited', async () => {
    const r0 = runnerRow(); deps.store.runners.set(r0.id, r0);
    expect((await call('post', '/runners/:id/test', { params: { id: r0.id } })).body.data).toEqual({ ok: true, outcome: 'pong' });
    deps.fetchMock.mockRejectedValue(new Error('timeout'));
    expect((await call('post', '/runners/:id/test', { params: { id: r0.id } })).body.data).toEqual({ ok: false, errorCode: 'timeout' });
    expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'pipeline.runner.test', outcome: 'failure', details: { ok: false, errorCode: 'timeout' } }));
    expect((await call('post', '/runners/:id/test', { params: { id: 'x' } })).statusCode).toBe(404);
  });

  it('DELETE revokes → 200 { runner }, audited with the counts', async () => {
    const r0 = runnerRow(); deps.store.runners.set(r0.id, r0);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: r0.id });
    const r = await call('delete', '/runners/:id', { params: { id: r0.id } });
    expect(r.body.data.runner).toMatchObject({ id: r0.id, status: 'revoked' });
    expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'pipeline.runner.revoke', details: { label: r0.label, linksCleared: 1, requestsExpired: 0 } }));
    expect((await call('delete', '/runners/:id', { params: { id: 'nope' } })).statusCode).toBe(404);
  });

  it('an unexpected error propagates (the route wrapper answers 500)', async () => {
    deps.store.countRunners = async () => { throw new Error('db down'); };
    await expect(call('post', '/runners', { body: { label: 'x' } })).rejects.toThrow('db down');
    deps.store.getRunner = async () => { throw new Error('db down'); };
    await expect(call('patch', '/runners/:id', { params: { id: '00000000-0000-4000-8000-000000000001' }, body: {} })).rejects.toThrow('db down');
    await expect(call('post', '/runners/:id/test', { params: { id: '00000000-0000-4000-8000-000000000001' } })).rejects.toThrow('db down');
    await expect(call('delete', '/runners/:id', { params: { id: '00000000-0000-4000-8000-000000000001' } })).rejects.toThrow('db down');
  });
});

describe('GET /pipelines/:pipelineId/run-requests/:requestId', () => {
  it('returns the documented shape; another org / malformed id → 404', async () => {
    const r0 = runnerRow(); deps.store.runners.set(r0.id, r0);
    const q = await deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', requestedAt: new Date(deps.clock.t), expiresAt: new Date(deps.clock.t + 600_000), runnerId: r0.id, status: 'failed', errorCode: 'RUNNER_REFUSED', attempts: 2 });
    const r = await call('get', '/:pipelineId/run-requests/:requestId', { params: { pipelineId: PIPE.toUpperCase(), requestId: q.id } });
    expect(r.body.data).toEqual({
      requestId: q.id,
      status: 'failed',
      action: 'start',
      runnerLabel: r0.label,
      executionId: null,
      executionStatus: null,
      errorCode: 'RUNNER_REFUSED',
      attempts: 2,
      requestedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect((await call('get', '/:pipelineId/run-requests/:requestId', { user: { sub: 'x', organizationId: PARENT }, params: { pipelineId: PIPE, requestId: q.id } })).statusCode).toBe(404);
    expect((await call('get', '/:pipelineId/run-requests/:requestId', { params: { pipelineId: PIPE, requestId: 'nope' } })).statusCode).toBe(404);
  });
});
