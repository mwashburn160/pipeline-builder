// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner HTTP routes' handlers with the real api-core envelope helpers and
 * an injected runner dependency bundle whose signer and key store are the real
 * per-org key code over fakes (no network, no database): response shapes,
 * RUNNERS_UNAVAILABLE, the per-runner JWKS (404s, limits, cache), the
 * signing-key, operator and internal routes, and that no response body, audit
 * entry or log line carries key material or the Function URL.
 */

import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { routeHandler, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from '../helpers/mock-api-core.js';

const mockAudit = jest.fn<(e: Record<string, unknown>) => void>();
const limiters: Array<{ opts: Record<string, unknown>; fn: unknown }> = [];
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: mockAudit }));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  createAuthenticatedWithOrgRoute: () => [],
  rateLimitByOrg: (opts: Record<string, unknown>) => {
    const fn = (_req: unknown, _res: unknown, next: () => void) => next();
    limiters.push({ opts, fn });
    return fn;
  },
  incCounter: () => undefined,
  setGauge: () => undefined,
  resetGauge: () => undefined,
  withRoute: (handler: (a: unknown) => Promise<unknown>) => async (req: { user?: Record<string, unknown> }, response: unknown) =>
    handler({ req, res: response, ctx: { log: () => undefined }, orgId: String(req.user?.organizationId ?? ''), userId: String(req.user?.sub ?? '') }),
}));

const { createInternalRunnerKeyRoutes, createRunnerJwksRoutes, createRunnerRoutes, requireRunnersAvailable, runnerJwksUrl } = await import('../../src/routes/runner-routes.js');
const { applyKeyInvalidation, setRunnerDepsForTesting } = await import('../../src/runners/deps.js');
const { verifyEdDsaJws } = await import('../../src/runners/jws.js');
const { resetRunRequestCachesForTesting } = await import('../../src/runners/run-request-status.js');
const { keyedDeps } = await import('../helpers/key-fakes.js');
const { ORG, PARENT, PIPE, reply, runnerRow, URL_A } = await import('../helpers/runner-fakes.js');

type Res = { statusCode?: number; body?: any; headers: Record<string, string>; status: (n: number) => unknown; json: (b: unknown) => unknown; setHeader: (k: string, v: string) => void };
function res(): Res {
  const r: Res = {
    headers: {},
    status(n) { r.statusCode = n; return r; },
    json(b) { r.body = b; return r; },
    setHeader(k, v) { r.headers[k] = v; },
  };
  return r;
}
const SYSTEM = '000000000000000000000001';
const user = { sub: 'user-1', organizationId: ORG };
const operator = { sub: 'op-1', organizationId: SYSTEM };
const router = createRunnerRoutes();
const jwksRouter = createRunnerJwksRoutes();
/** Every response body a test produced (checked for key material at the end of each test). */
let bodies: unknown[] = [];
const call = async (method: string, path: string, req: Record<string, unknown> = {}) => {
  const r = res();
  await routeHandler(router, method, path)({ user, params: {}, query: {}, body: {}, headers: {}, ...req }, r);
  bodies.push(r.body);
  return r;
};
const jwks = async (runnerId: string, ip = '198.51.100.1') => {
  const r = res();
  await routeHandler(jwksRouter, 'get', '/runners/:runnerId/jwks.json')({ params: { runnerId }, ip }, r);
  bodies.push(r.body);
  return r;
};

let deps: ReturnType<typeof keyedDeps>;
beforeEach(() => {
  mockAudit.mockReset();
  bodies = [];
  deps = keyedDeps();
  setRunnerDepsForTesting(deps);
  resetRunRequestCachesForTesting();
});
afterEach(() => {
  // No route answer, audit entry or invalidation message carries a private key or its ciphertext.
  const out = JSON.stringify([bodies, mockAudit.mock.calls, deps.audits, deps.notified, deps.published]);
  expect(out).not.toMatch(/PRIVATE KEY|LS0tLS1CRUdJTi|privateKeyEnc|private_key_enc|"alg":"fake"|"d":/);
  for (const k of deps.keyStore.keys.values()) if (k.privateKeyEnc) expect(out).not.toContain(k.privateKeyEnc);
  setRunnerDepsForTesting(null);
});

describe('unavailable (paused / no secret encryption / no tables)', () => {
  it.each(['paused', 'encryption_not_configured'] as const)('%s: GET answers available:false with the reason and no signingKey; writes answer 409 RUNNERS_UNAVAILABLE', async (reason) => {
    deps.availability.available = false;
    deps.availability.reason = reason;
    const list = await call('get', '/runners');
    expect(list.body.data).toEqual({ available: false, unavailableReason: reason, platformEgressIps: null, own: [], inherited: [], signingKey: null });
    const gate = res();
    const next = jest.fn();
    await requireRunnersAvailable({} as never, gate as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(gate.statusCode).toBe(409);
    expect(gate.body).toMatchObject({ code: 'RUNNERS_UNAVAILABLE', details: { reason } });
  });

  /** The middleware of one route, in order (from the real router stack). */
  const stackOf = (method: string, path: string): any[] => {
    const layer = (router as unknown as { stack: any[] }).stack.find((l) => l.route?.path === path && l.route?.methods?.[method]);
    return layer.route.stack.map((h: { handle: unknown }) => h.handle);
  };
  const gateOf = (method: string, path: string) => stackOf(method, path).find((h) => /^requireRunners/.test(h.name));
  const runGate = async (gate: any) => { const r = res(); const next = jest.fn(); await gate({}, r, next); return { r, passed: next.mock.calls.length > 0 }; };

  it('key writes are allowed while deliveries are paused (only encryption and tables gate them); runner writes are not', async () => {
    const { RUNNERS_UNAVAILABLE_MESSAGES } = await import('../../src/runners/routing.js');
    deps.availability.available = false;
    deps.availability.reason = 'paused';
    for (const [method, path] of [['post', '/runners/signing-key'], ['post', '/runners/signing-key/rotate'], ['delete', '/runners/signing-key/rotate'],
      ['post', '/runners/signing-key/finish'], ['post', '/runners/signing-key/revoke'], ['put', '/runners/signing-key/mode']] as const) {
      expect((await runGate(gateOf(method, path))).passed).toBe(true);
    }
    const blocked = await runGate(gateOf('post', '/runners'));
    expect(blocked.passed).toBe(false);
    expect(blocked.r.body).toMatchObject({ code: 'RUNNERS_UNAVAILABLE', message: RUNNERS_UNAVAILABLE_MESSAGES.paused, details: { reason: 'paused' } });
    // Not set up at all: key writes are refused too, with the shared message.
    deps.availability.reason = 'encryption_not_configured';
    const key = await runGate(gateOf('post', '/runners/signing-key/rotate'));
    expect(key.passed).toBe(false);
    expect(key.r.body).toMatchObject({ code: 'RUNNERS_UNAVAILABLE', message: RUNNERS_UNAVAILABLE_MESSAGES.encryption_not_configured, details: { reason: 'encryption_not_configured' } });
    // No reason given: the default every runner path uses (paused).
    delete deps.availability.reason;
    expect((await runGate(gateOf('post', '/runners'))).r.body).toMatchObject({ details: { reason: 'paused' }, message: RUNNERS_UNAVAILABLE_MESSAGES.paused });
  });

  it('the gate passes when available; an unknown run request is a 404', async () => {
    const next = jest.fn();
    await requireRunnersAvailable({} as never, res() as never, next);
    expect(next).toHaveBeenCalled();
    expect((await call('get', '/:pipelineId/run-requests/:requestId', { params: { pipelineId: PIPE, requestId: '00000000-0000-4000-8000-000000000001' } })).statusCode).toBe(404);
  });
});

describe('GET /pipelines/runner/runners/:runnerId/jwks.json', () => {
  it('serves the owner\'s keys as a bare JWK set to pending and active runners, cacheable for 60 s', async () => {
    const { kid } = await (await import('../../src/runners/keys.js')).generateOrgKey(deps, ORG, { userId: 'u' });
    const active = runnerRow(); deps.store.runners.set(active.id, active);
    const pending = runnerRow({ status: 'pending', functionUrl: null }); deps.store.runners.set(pending.id, pending);
    for (const id of [active.id, pending.id]) {
      const r = await jwks(id);
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: expect.any(String), kid, use: 'sig', alg: 'EdDSA' }] });
      expect(r.headers['Cache-Control']).toBe('public, max-age=60');
    }
    // Served from the 60 s server cache…
    const reads = jest.spyOn(deps.store, 'getRunner');
    await jwks(active.id);
    expect(reads).not.toHaveBeenCalled();
    // …until it ages out, or a key change for the owner drops it.
    applyKeyInvalidation(deps, { v: 1, kind: 'keys', origin: 'x', orgIds: [ORG] });
    await jwks(active.id);
    expect(reads).toHaveBeenCalledTimes(1);
    deps.clock.t += 61_000;
    await jwks(active.id);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('unknown, malformed and revoked runners, and an owner with no keys, all get the same 404 (not cacheable)', async () => {
    const revoked = runnerRow({ status: 'revoked' }); deps.store.runners.set(revoked.id, revoked);
    const keyless = runnerRow({ orgId: PARENT }); deps.store.runners.set(keyless.id, keyless);
    await (await import('../../src/runners/keys.js')).generateOrgKey(deps, ORG, { userId: 'u' });
    const answers = [];
    for (const id of ['99999999-9999-4999-8999-999999999999', 'not-a-uuid', revoked.id, keyless.id]) answers.push(await jwks(id));
    for (const r of answers) {
      expect(r.statusCode).toBe(404);
      expect(r.body).toEqual(answers[0]!.body);
      expect(r.headers['Cache-Control']).toBe('no-store');
    }
    // A store failure fails closed the same way.
    deps.store.getRunner = async () => { throw new Error('db down'); };
    expect((await jwks('99999999-9999-4999-8999-999999999998')).statusCode).toBe(404);
  });

  it('per-runner limit (10/min) and a per-IP backstop (600/min) answer 429', async () => {
    const id = '99999999-9999-4999-8999-999999999999';
    for (let i = 0; i < 10; i++) expect((await jwks(id, `203.0.113.${i}`)).statusCode).toBe(404);
    const limited = await jwks(id, '203.0.113.99');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['Retry-After']).toBe('60');
    const hit = jest.fn(async (key: string, max: number, _windowMs: number) => !(key.startsWith('jwks-ip:') && max === 600));
    deps.limiter.hit = hit;
    expect((await jwks(id)).statusCode).toBe(429);
    expect(hit).toHaveBeenCalledWith('jwks-ip:198.51.100.1', 600, 60_000);
  });

  it('a revoked runner\'s JWKS answers 404 right after the revoke (cache dropped)', async () => {
    await (await import('../../src/runners/keys.js')).generateOrgKey(deps, ORG, { userId: 'u' });
    const r0 = runnerRow(); deps.store.runners.set(r0.id, r0);
    expect((await jwks(r0.id)).statusCode).toBe(200);
    await call('delete', '/runners/:id', { params: { id: r0.id } });
    expect((await jwks(r0.id)).statusCode).toBe(404);
    expect(deps.published).toContainEqual({ kind: 'keys', orgIds: [ORG] });
  });

  it('runnerJwksUrl is per runner, on PLATFORM_BASE_URL', () => {
    expect(runnerJwksUrl('r-1', { PLATFORM_BASE_URL: 'https://pb.example.com/' })).toBe('https://pb.example.com/api/pipelines/runner/runners/r-1/jwks.json');
    expect(runnerJwksUrl('r-1', {})).toBe('/api/pipelines/runner/runners/r-1/jwks.json');
  });
});

describe('signing-key routes', () => {
  it('generate → 201 DTO (ids and dates only); a second → 409 RUNNER_KEY_EXISTS, audited as a failure with its code', async () => {
    const r = await call('post', '/runners/signing-key');
    expect(r.statusCode).toBe(201);
    expect(r.body.data).toMatchObject({ mode: 'own', isRootOrg: true, rotation: 'none', active: { kid: expect.any(String), state: 'active', ageDays: 0 }, next: null, retiring: null, unreadable: false });
    const again = await call('post', '/runners/signing-key');
    expect(again.statusCode).toBe(409);
    expect(again.body).toMatchObject({ code: 'RUNNER_KEY_EXISTS' });
    expect(deps.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.generate', outcome: 'failure', details: { reason: 'RUNNER_KEY_EXISTS' } }));
  });

  it('rotate → pending; DELETE cancels; finish with nothing retiring → 409; revoke needs the typed confirmation', async () => {
    const gen = await call('post', '/runners/signing-key');
    const kid = gen.body.data.active.kid as string;
    const rot = await call('post', '/runners/signing-key/rotate');
    expect(rot.body.data).toMatchObject({ rotation: 'pending', next: { state: 'next', ageDays: 0 } });
    expect((await call('post', '/runners/signing-key/rotate')).body).toMatchObject({ code: 'RUNNER_KEY_TRANSITION_IN_PROGRESS' });
    expect((await call('delete', '/runners/signing-key/rotate')).body.data).toMatchObject({ rotation: 'none', next: null });
    expect((await call('delete', '/runners/signing-key/rotate')).body).toMatchObject({ code: 'RUNNER_KEY_NO_ROTATION' });
    expect((await call('post', '/runners/signing-key/finish')).statusCode).toBe(409);
    expect((await call('post', '/runners/signing-key/revoke', { body: {} })).statusCode).toBe(400);
    const wrong = await call('post', '/runners/signing-key/revoke', { body: { confirm: 'zzzzzz' } });
    expect([wrong.statusCode, wrong.body.code]).toEqual([400, 'RUNNER_KEY_CONFIRMATION_MISMATCH']);
    const ok = await call('post', '/runners/signing-key/revoke', { body: { confirm: kid.slice(-6) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.active.kid).not.toBe(kid);
  });

  it('mode: a root org → 409 RUNNER_KEY_MODE_ROOT_ORG; a team switches to own (200, transition shown); a bad body → 400', async () => {
    expect((await call('put', '/runners/signing-key/mode', { body: { mode: 'inherit' } })).body).toMatchObject({ code: 'RUNNER_KEY_MODE_ROOT_ORG' });
    expect((await call('put', '/runners/signing-key/mode', { body: { mode: 'shared' } })).statusCode).toBe(400);
    deps.parents.set(ORG, PARENT);
    await (await import('../../src/runners/keys.js')).generateOrgKey(deps, PARENT, { userId: 'u' });
    const inherit = await call('get', '/runners');
    expect(inherit.body.data.signingKey).toMatchObject({ mode: 'inherit', inheritedFrom: { orgId: PARENT } });
    expect((await call('put', '/runners/signing-key/mode', { body: { mode: 'inherit' } })).statusCode).toBe(400);
    const own = await call('put', '/runners/signing-key/mode', { body: { mode: 'own' } });
    expect(own.statusCode).toBe(200);
    expect(own.body.data).toMatchObject({ mode: 'own', next: { state: 'next' }, transition: { kind: 'to_own' } });
  });

  it('every key write carries the 5-per-org-per-hour limit; the runner test its own', () => {
    const keyLimit = limiters.find((l) => l.opts.name === 'pipeline-runner-key-write')!;
    // Fail closed: a limit-store outage must not lift the key-write limit; the test limiter keeps the default.
    expect(keyLimit.opts).toMatchObject({ max: 5, windowMs: 3_600_000, failClosed: true });
    expect(limiters.find((l) => l.opts.name === 'pipeline-runner-test')!.opts.failClosed).toBeUndefined();
    const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack;
    const keyRoutes = stack.filter((l) => l.route?.path.startsWith('/runners/signing-key'));
    expect(keyRoutes.map((l) => `${Object.keys(l.route!.methods)[0]} ${l.route!.path}`).sort()).toEqual([
      'delete /runners/signing-key/rotate', 'post /runners/signing-key', 'post /runners/signing-key/finish',
      'post /runners/signing-key/revoke', 'post /runners/signing-key/rotate', 'put /runners/signing-key/mode',
    ]);
    for (const l of keyRoutes) expect(l.route!.stack.some((h) => h.handle === keyLimit.fn)).toBe(true);
    // Registered before /runners/:id.
    const firstKey = stack.findIndex((l) => l.route?.path.startsWith('/runners/signing-key'));
    const firstId = stack.findIndex((l) => l.route?.path.startsWith('/runners/:id'));
    expect(firstKey).toBeLessThan(firstId);
  });
});

describe('operator routes', () => {
  it('GET /admin/runner-signing-keys: paginated rows, filterable', async () => {
    await (await import('../../src/runners/keys.js')).generateOrgKey(deps, ORG, { userId: 'u' });
    const r = await call('get', '/admin/runner-signing-keys', { user: operator, query: { limit: '10' } });
    expect(r.body.data).toMatchObject({ orgs: [{ orgId: ORG, mode: 'own', rotation: 'none', unreadable: false }], pagination: expect.objectContaining({ total: 1, limit: 10, offset: 0 }) });
    expect((await call('get', '/admin/runner-signing-keys', { user: operator, query: { unreadable: 'true' } })).body.data.orgs).toEqual([]);
    expect((await call('get', '/admin/runner-signing-keys', { user: operator, query: { mode: 'bogus' } })).statusCode).toBe(400);
  });

  it('POST /admin/orgs/:orgId/runner-signing-key/revoke: revokes that org\'s key; unknown or malformed org → 404', async () => {
    const { kid } = await (await import('../../src/runners/keys.js')).generateOrgKey(deps, ORG, { userId: 'u' });
    const r = await call('post', '/admin/orgs/:orgId/runner-signing-key/revoke', { user: operator, params: { orgId: ORG.toUpperCase() }, body: { reason: 'leaked' } });
    expect(r.body.data).toEqual({ orgId: ORG, revokedKid: kid, activeKid: expect.any(String) });
    expect(deps.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.system_revoke', actorId: 'op-1', affectedOrgId: ORG }));
    expect((await call('post', '/admin/orgs/:orgId/runner-signing-key/revoke', { user: operator, params: { orgId: 'x' } })).statusCode).toBe(404);
    deps.hierarchy.names = async () => ({});
    expect((await call('post', '/admin/orgs/:orgId/runner-signing-key/revoke', { user: operator, params: { orgId: 'cccccccccccccccccccccccc' } })).statusCode).toBe(404);
  });

  it('GET/PUT /admin/runner-deliveries: the pause toggle, published to every replica and audited', async () => {
    expect((await call('get', '/admin/runner-deliveries', { user: operator })).body.data).toEqual({ paused: false, pausedAt: null, pausedBy: null, reason: null });
    const on = await call('put', '/admin/runner-deliveries', { user: operator, body: { paused: true, reason: 'incident' } });
    expect(on.body.data).toMatchObject({ paused: true, pausedBy: 'op-1', reason: 'incident' });
    expect(deps.published).toContainEqual({ kind: 'pause', paused: true });
    expect(deps.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.deliveries.pause', targetType: 'platform', targetId: 'runner-deliveries', details: { reason: 'incident' } }));
    expect(await deps.deliveriesPaused()).toBe(true);
    await call('put', '/admin/runner-deliveries', { user: operator, body: { paused: false } });
    expect(deps.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.deliveries.resume' }));
    expect((await call('put', '/admin/runner-deliveries', { user: operator, body: {} })).statusCode).toBe(400);
  });
});

describe('POST /pipelines/internal/runner-signing-keys/reencrypt', () => {
  const internal = createInternalRunnerKeyRoutes();
  const post = async (body: unknown) => {
    const r = res();
    await routeHandler(internal, 'post', '/runner-signing-keys/reencrypt')({ body, params: {}, query: {}, headers: {} }, r);
    bodies.push(r.body);
    return r;
  };
  it('runs the job and answers the counts; a body the contract rejects → 400; no secret encryption → 500', async () => {
    const r0 = await post({});
    expect(r0.statusCode).toBe(500);
    process.env.SECRET_ENCRYPTION_KEY = 'c'.repeat(64);
    const { resetDefaultKeyProvider } = jest.requireActual('@pipeline-builder/api-core') as { resetDefaultKeyProvider: () => void };
    resetDefaultKeyProvider();
    const r = await post({});
    expect(r.statusCode).toBe(200);
    expect(r.body.data).toEqual({ scanned: 0, reencrypted: 0, failures: [] });
    expect((await post({ orgId: 'nope' })).statusCode).toBe(400);
    expect((await post({ extra: 1 })).statusCode).toBe(400);
    deps.keyStore.encryptedKeyIds = async () => { throw new Error('db down'); };
    expect((await post({})).statusCode).toBe(500);
    delete process.env.SECRET_ENCRYPTION_KEY;
    resetDefaultKeyProvider();
  });
});

describe('runner admin', () => {
  it('GET lists own + inherited with platformEgressIps, a JWKS URL per runner and the signing-key status', async () => {
    process.env.RUNNER_PLATFORM_EGRESS_IPS = '203.0.113.7';
    try {
      deps.parents.set(ORG, PARENT);
      const own = runnerRow(); deps.store.runners.set(own.id, own);
      const inh = runnerRow({ orgId: PARENT }); deps.store.runners.set(inh.id, inh);
      const r = await call('get', '/runners', { user: { ...user, parentOrganizationId: PARENT } });
      expect(r.body.data).toMatchObject({
        available: true,
        unavailableReason: null,
        platformEgressIps: ['203.0.113.7'],
        own: [{ id: own.id, functionUrl: URL_A, jwksUrl: `/api/pipelines/runner/runners/${own.id}/jwks.json` }],
        inherited: [{ id: inh.id, functionUrl: null, fromOrgId: PARENT, jwksUrl: `/api/pipelines/runner/runners/${inh.id}/jwks.json` }],
        signingKey: { mode: 'inherit', isRootOrg: false },
      });
      expect(r.body.data).not.toHaveProperty('jwksUrl');
    } finally {
      delete process.env.RUNNER_PLATFORM_EGRESS_IPS;
    }
  });

  it('POST registers (pending without a URL; active after a pong with one) → 201 { runner }, audited without the URL', async () => {
    const pending = await call('post', '/runners', { body: { label: 'new' } });
    expect(pending.statusCode).toBe(201);
    expect(pending.body.data.runner).toMatchObject({ status: 'pending', functionUrl: null, label: 'new', jwksUrl: expect.stringContaining('/jwks.json') });
    // The first runner created the org's key, active (audited, auto).
    expect(deps.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.generate', orgId: ORG, details: expect.objectContaining({ state: 'active', auto: true }) }));
    expect([...deps.keyStore.keys.values()].map((k) => k.state)).toEqual(['active']);
    const active = await call('post', '/runners', { body: { label: 'prod', functionUrl: URL_A, regions: ['us-east-1'] } });
    expect(active.statusCode).toBe(201);
    expect(active.body.data.runner).toMatchObject({ status: 'active', functionUrl: URL_A });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline.runner.register', targetId: active.body.data.runner.id }));
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(URL_A);
    // The activation ping was signed with the org's key, which the runner's own JWKS (pending at the time) serves.
    const ping = String(deps.fetchMock.mock.calls[0]![1].body);
    const set = (await jwks(active.body.data.runner.id)).body as { keys: never[] };
    expect(verifyEdDsaJws(ping, set.keys).payload).toMatchObject({ aud: active.body.data.runner.id, action: 'ping' });
  });

  it('runner writes refuse 409 RUNNER_KEY_UNREADABLE when the org key can\'t be decrypted; revoke still works', async () => {
    const r0 = runnerRow(); deps.store.runners.set(r0.id, r0);
    await call('post', '/runners', { body: { label: 'first' } });
    deps.secrets.unreadable.add(ORG);
    deps.keyCaches.signers.clear();
    const reg = await call('post', '/runners', { body: { label: 'x', functionUrl: URL_A } });
    expect([reg.statusCode, reg.body.code]).toEqual([409, 'RUNNER_KEY_UNREADABLE']);
    expect((await call('post', '/runners/:id/test', { params: { id: r0.id } })).body.code).toBe('RUNNER_KEY_UNREADABLE');
    expect((await call('patch', '/runners/:id', { params: { id: r0.id }, body: { functionUrl: URL_A } })).body.code).toBe('RUNNER_KEY_UNREADABLE');
    expect((await call('get', '/runners')).body.data.signingKey).toMatchObject({ unreadable: true });
    expect((await call('delete', '/runners/:id', { params: { id: r0.id } })).statusCode).toBe(200);
    expect(deps.fetchMock).not.toHaveBeenCalled();
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
    await (await import('../../src/runners/keys.js')).generateOrgKey(deps, ORG, { userId: 'u' });
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
    await (await import('../../src/runners/keys.js')).generateOrgKey(deps, ORG, { userId: 'u' });
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
