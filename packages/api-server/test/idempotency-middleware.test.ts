// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: {
    IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60000,
    IDEMPOTENCY_TTL_MS: 60000,
    IDEMPOTENCY_PENDING_TTL_MS: 30000,
    IDEMPOTENCY_MAX_STORE_SIZE: 1000,
  },
}));

const {
  idempotencyMiddleware,
  createRedisIdempotencyStore,
  setIdempotencyStore,
  createMemoryStore,
  isIdempotentReplay,
} = await import('../src/api/idempotency-middleware.js');

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    method: 'POST',
    headers: {},
    context: { identity: { orgId: 'org-1' } },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    headersSent: false,
  };
  const listeners: Record<string, Array<() => void>> = {};
  res.setHeader = jest.fn((name: string, value: string) => { res.headers[name] = value; });
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn().mockReturnValue(res);
  // Non-json completion paths (res.send/res.end) that the middleware must also
  // resolve. Kept independent from res.json (test doubles don't chain).
  res.send = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  // Minimal EventEmitter surface for the `finish` backstop.
  res.on = jest.fn((event: string, cb: () => void) => { (listeners[event] ||= []).push(cb); return res; });
  res.emit = (event: string) => { (listeners[event] || []).forEach((cb) => cb()); };
  return res;
}

describe('idempotencyMiddleware', () => {
  it('skips when no idempotency-key header is present', () => {
    const middleware = idempotencyMiddleware();
    const req = mockReq();
    const res = mockRes();
    const originalJson = res.json;
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.json).toBe(originalJson);
  });

  it('skips for GET requests', () => {
    const middleware = idempotencyMiddleware();
    const req = mockReq({ method: 'GET', headers: { 'idempotency-key': 'k1' } });
    const res = mockRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('skips when no orgId on request', () => {
    const middleware = idempotencyMiddleware();
    const req = mockReq({
      headers: { 'idempotency-key': 'k1' },
      context: { identity: {} },
    });
    const res = mockRes();
    const originalJson = res.json;
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.json).toBe(originalJson);
  });

  // Note: middleware now performs an async store.get() lookup before
  // intercepting res.json — these tests await with `setImmediate` to let
  // the microtask queue drain. With the default in-memory store the
  // lookup resolves synchronously-ish; one microtask tick is enough.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('intercepts res.json on first call with key', async () => {
    const middleware = idempotencyMiddleware();
    const req = mockReq({ headers: { 'idempotency-key': 'fresh-key-1' } });
    const res = mockRes();
    const originalJson = res.json;
    middleware(req, res, jest.fn());
    await flush();
    expect(res.json).not.toBe(originalJson);
  });

  it('replays cached response on second call with same key', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'cache-key-' + Math.random();

    // First call — caches response
    const req1 = mockReq({ headers: { 'idempotency-key': key } });
    const res1 = mockRes();
    res1.statusCode = 201;
    middleware(req1, res1, jest.fn());
    await flush();
    res1.json({ id: 'created' });

    // Second call — should replay from cache
    const req2 = mockReq({ headers: { 'idempotency-key': key } });
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);
    await flush();

    expect(next2).not.toHaveBeenCalled();
    expect(res2.setHeader).toHaveBeenCalledWith('X-Idempotent-Replayed', 'true');
    expect(res2.status).toHaveBeenCalledWith(201);
    expect(res2.json).toHaveBeenCalledWith({ id: 'created' });
    // Flagged for per-success billing (meterQuotaOnSuccess skips replays);
    // the original response was not.
    expect(isIdempotentReplay(res2)).toBe(true);
    expect(isIdempotentReplay(res1)).toBe(false);
  });

  it('rejects a concurrent duplicate (same key, original still in-flight) with 409', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'inflight-key-' + Math.random();

    // First call reserves the key and is left in-flight (res1.json NOT called).
    const req1 = mockReq({ headers: { 'idempotency-key': key } });
    const res1 = mockRes();
    const next1 = jest.fn();
    middleware(req1, res1, next1);
    await flush();
    expect(next1).toHaveBeenCalled(); // first request proceeds

    // Second call with the same key, before the first completed → 409, no run.
    const req2 = mockReq({ headers: { 'idempotency-key': key } });
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);
    await flush();

    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.setHeader).toHaveBeenCalledWith('Retry-After', '1');
  });

  it('prefers the verified req.user org over req.context.identity for the namespace', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'verified-org-' + Math.random();

    // Cache under the VERIFIED user org even though context.identity differs.
    const req1 = mockReq({
      headers: { 'idempotency-key': key },
      context: { identity: { orgId: 'unverified-peek' } },
      user: { organizationId: 'verified-org' },
    });
    const res1 = mockRes();
    res1.statusCode = 200;
    middleware(req1, res1, jest.fn());
    await flush();
    res1.json({ ok: true });

    // A replay carrying the SAME verified user org replays the cached response.
    const req2 = mockReq({
      headers: { 'idempotency-key': key },
      context: { identity: { orgId: 'something-else' } },
      user: { organizationId: 'verified-org' },
    });
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);
    await flush();
    expect(next2).not.toHaveBeenCalled();
    expect(res2.setHeader).toHaveBeenCalledWith('X-Idempotent-Replayed', 'true');
    expect(res2.json).toHaveBeenCalledWith({ ok: true });
  });

  it('namespaces cache by orgId to prevent cross-org collisions', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'shared-key-' + Math.random();

    // Org A caches
    const reqA = mockReq({
      headers: { 'idempotency-key': key },
      context: { identity: { orgId: 'org-a' } },
    });
    const resA = mockRes();
    middleware(reqA, resA, jest.fn());
    await flush();
    resA.json({ for: 'a' });

    // Org B sees no cached entry
    const reqB = mockReq({
      headers: { 'idempotency-key': key },
      context: { identity: { orgId: 'org-b' } },
    });
    const resB = mockRes();
    const nextB = jest.fn();
    middleware(reqB, resB, nextB);
    await flush();
    expect(nextB).toHaveBeenCalled();
  });

  it('does NOT cross-replay the same key used on two different routes', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'cross-route-' + Math.random();

    // Route A caches a 201.
    const reqA = mockReq({ headers: { 'idempotency-key': key }, path: '/pipelines' });
    const resA = mockRes();
    resA.statusCode = 201;
    middleware(reqA, resA, jest.fn());
    await flush();
    resA.json({ id: 'pipeline' });

    // SAME key on a DIFFERENT route must run its own handler, not replay A's response.
    const reqB = mockReq({ headers: { 'idempotency-key': key }, path: '/plugins' });
    const resB = mockRes();
    const nextB = jest.fn();
    middleware(reqB, resB, nextB);
    await flush();
    expect(nextB).toHaveBeenCalled();
    expect(resB.setHeader).not.toHaveBeenCalledWith('X-Idempotent-Replayed', 'true');
  });

  it('does NOT cross-replay the same key used on two different methods', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'cross-method-' + Math.random();

    const reqPost = mockReq({ method: 'POST', headers: { 'idempotency-key': key }, path: '/thing' });
    const resPost = mockRes();
    middleware(reqPost, resPost, jest.fn());
    await flush();
    resPost.json({ via: 'post' });

    const reqDelete = mockReq({ method: 'DELETE', headers: { 'idempotency-key': key }, path: '/thing' });
    const resDelete = mockRes();
    const nextDelete = jest.fn();
    middleware(reqDelete, resDelete, nextDelete);
    await flush();
    expect(nextDelete).toHaveBeenCalled();
  });

  it('does NOT replay when the same key is reused with a DIFFERENT body', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'body-fp-' + Math.random();

    const req1 = mockReq({ headers: { 'idempotency-key': key }, path: '/things', body: { name: 'a' } });
    const res1 = mockRes();
    middleware(req1, res1, jest.fn());
    await flush();
    res1.json({ id: 'a' });

    // Same key + route, different payload → distinct operation, runs the handler.
    const req2 = mockReq({ headers: { 'idempotency-key': key }, path: '/things', body: { name: 'b' } });
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);
    await flush();
    expect(next2).toHaveBeenCalled();
  });

  it('caches a 2xx completed via res.send (bypassing res.json) so a retry is not stuck at 409', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'send-path-' + Math.random();

    // Handler completes with res.send() and never touches res.json.
    const req1 = mockReq({ headers: { 'idempotency-key': key }, path: '/send' });
    const res1 = mockRes();
    const next1 = jest.fn();
    middleware(req1, res1, next1);
    await flush();
    expect(next1).toHaveBeenCalled();
    res1.status(200);
    res1.send({ ok: true });
    res1.emit('finish');
    await flush();

    // Retry replays the cached response instead of getting an in-progress 409.
    const req2 = mockReq({ headers: { 'idempotency-key': key }, path: '/send' });
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);
    await flush();
    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).not.toHaveBeenCalledWith(409);
    expect(res2.setHeader).toHaveBeenCalledWith('X-Idempotent-Replayed', 'true');
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(res2.json).toHaveBeenCalledWith({ ok: true });
  });

  it('resolves a 204 completed via res.end (bypassing res.json) so a retry is not stuck at 409', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'end-path-' + Math.random();

    const req1 = mockReq({ headers: { 'idempotency-key': key }, path: '/end' });
    const res1 = mockRes();
    const next1 = jest.fn();
    middleware(req1, res1, next1);
    await flush();
    expect(next1).toHaveBeenCalled();
    res1.status(204);
    res1.end();
    res1.emit('finish');
    await flush();

    const req2 = mockReq({ headers: { 'idempotency-key': key }, path: '/end' });
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);
    await flush();
    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).not.toHaveBeenCalledWith(409);
    expect(res2.status).toHaveBeenCalledWith(204);
  });

  it('releases the reservation when a NON-2xx finishes without res.json (retry can proceed)', async () => {
    const middleware = idempotencyMiddleware();
    const key = 'fail-finish-' + Math.random();

    const req1 = mockReq({ headers: { 'idempotency-key': key }, path: '/boom' });
    const res1 = mockRes();
    middleware(req1, res1, jest.fn());
    await flush();
    res1.status(500);
    res1.end();
    res1.emit('finish'); // non-2xx finish → reservation released
    await flush();

    // Retry after failure gets to run again (no stranded reservation / stuck 409).
    const req2 = mockReq({ headers: { 'idempotency-key': key }, path: '/boom' });
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);
    await flush();
    expect(next2).toHaveBeenCalled();
    expect(res2.status).not.toHaveBeenCalledWith(409);
  });

  it('fails open (proceeds without dedup) when the store backend errors', async () => {
    const throwingStore = {
      get: async () => { throw new Error('store down'); },
      set: async () => undefined,
      reserve: async () => true,
      delete: async () => undefined,
    };
    const middleware = idempotencyMiddleware({ store: throwingStore });
    const req = mockReq({ headers: { 'idempotency-key': 'k-store-err' } });
    const res = mockRes();
    const next = jest.fn();
    middleware(req, res, next);
    await flush();
    expect(next).toHaveBeenCalled();
  });

  it('uses the process-wide store set via setIdempotencyStore when no explicit store is passed', async () => {
    // Track that the injected default store is the one actually consulted.
    const calls: string[] = [];
    const injected = {
      get: async () => { calls.push('get'); return null; },
      set: async () => { calls.push('set'); },
      reserve: async () => { calls.push('reserve'); return true; },
      delete: async () => { calls.push('delete'); },
    };
    setIdempotencyStore(injected);
    try {
      const middleware = idempotencyMiddleware(); // no explicit store
      const req = mockReq({ headers: { 'idempotency-key': 'default-store-key' }, path: '/inj' });
      const res = mockRes();
      middleware(req, res, jest.fn());
      await flush();
      expect(calls).toContain('get');
      expect(calls).toContain('reserve');
    } finally {
      setIdempotencyStore(createMemoryStore()); // restore isolation for other suites
    }
  });
});

describe('createRedisIdempotencyStore', () => {
  /** Minimal in-memory stand-in for the ioredis SET/GET/DEL surface with NX/EX. */
  function fakeRedis() {
    const map = new Map<string, string>();
    return {
      map,
      async get(k: string) { return map.has(k) ? (map.get(k) as string) : null; },
      async set(k: string, v: string, ...args: (string | number)[]) {
        const nx = args.includes('NX');
        if (nx && map.has(k)) return null; // NX refused — key already present
        map.set(k, v);
        return 'OK';
      },
      async del(k: string) { return map.delete(k) ? 1 : 0; },
    };
  }

  const entry = { statusCode: 201, body: { id: 'x' }, bodyKind: 'json' as const, expiresAt: Date.now() + 60000 };

  it('reserve claims a key once (SET NX); a second reserve loses', async () => {
    const store = createRedisIdempotencyStore(fakeRedis());
    expect(await store.reserve('k1', entry, 60)).toBe(true);
    expect(await store.reserve('k1', entry, 60)).toBe(false);
  });

  it('set then get round-trips the cached entry', async () => {
    const store = createRedisIdempotencyStore(fakeRedis());
    await store.set('k2', entry, 60);
    expect(await store.get('k2')).toEqual(entry);
  });

  it('delete releases a reservation so a later reserve wins again', async () => {
    const store = createRedisIdempotencyStore(fakeRedis());
    expect(await store.reserve('k3', entry, 60)).toBe(true);
    await store.delete('k3');
    expect(await store.reserve('k3', entry, 60)).toBe(true);
  });

  it('get returns null for a corrupt (non-JSON) entry rather than throwing', async () => {
    const redis = fakeRedis();
    redis.map.set('idem:k4', '{not json');
    const store = createRedisIdempotencyStore(redis);
    expect(await store.get('k4')).toBeNull();
  });
});

describe('idempotency key scoping and abort handling', () => {
  beforeEach(() => {
    setIdempotencyStore(createMemoryStore());
  });

  /** Drive one request through the middleware to completion at `statusCode`. */
  async function run(req: any, statusCode = 200, body: unknown = { ok: true }) {
    const middleware = idempotencyMiddleware();
    const res = mockRes();
    const next = jest.fn();
    middleware(req, res, next);
    await new Promise((r) => setImmediate(r));
    if (next.mock.calls.length > 0) {
      res.statusCode = statusCode;
      res.json(body);
      await new Promise((r) => setImmediate(r));
    }
    return { res, next };
  }

  it('REGRESSION: two users in one org sharing a key do NOT collide', async () => {
    // The key used to be namespaced by org only, so the second user's mutation
    // was skipped and they received the FIRST user's cached response body.
    const first = await run(mockReq({
      headers: { 'idempotency-key': 'shared-key' },
      user: { organizationId: 'org-1', sub: 'user-a' },
      body: { name: 'x' },
    }), 201, { id: 'created-by-a' });
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = await run(mockReq({
      headers: { 'idempotency-key': 'shared-key' },
      user: { organizationId: 'org-1', sub: 'user-b' },
      body: { name: 'x' },
    }), 201, { id: 'created-by-b' });

    // user-b's request actually RAN rather than replaying user-a's response.
    expect(second.next).toHaveBeenCalledTimes(1);
    expect(second.res.headers['X-Idempotent-Replayed']).toBe('false');
  });

  it('still replays for the SAME user reusing the key', async () => {
    const req = () => mockReq({
      headers: { 'idempotency-key': 'same-user-key' },
      user: { organizationId: 'org-1', sub: 'user-a' },
      body: { name: 'x' },
    });
    const first = await run(req(), 201, { id: 'once' });
    expect(first.next).toHaveBeenCalledTimes(1);

    const replay = await run(req(), 201, { id: 'twice' });
    // Replayed from cache — the handler never ran again.
    expect(replay.next).not.toHaveBeenCalled();
    expect(replay.res.headers['X-Idempotent-Replayed']).toBe('true');
  });

  it('REGRESSION: a client disconnect does NOT release the key while the handler still runs', async () => {
    // Releasing on 'close' let the client's retry execute the mutation a second
    // time while the first handler was still going to commit it.
    const middleware = idempotencyMiddleware();
    const aborted = mockRes();
    const next1 = jest.fn();
    const reqFor = () => mockReq({
      headers: { 'idempotency-key': 'abort-key' },
      user: { organizationId: 'org-1', sub: 'user-a' },
      body: { n: 1 },
    });
    middleware(reqFor(), aborted, next1);
    await new Promise((r) => setImmediate(r));
    expect(next1).toHaveBeenCalledTimes(1);

    // Client goes away before the response completes.
    aborted.writableFinished = false;
    aborted.emit('close');
    await new Promise((r) => setImmediate(r));

    // A retry now is refused (the original is still in flight)…
    const early = await run(reqFor());
    expect(early.next).not.toHaveBeenCalled();
    expect(early.res.status).toHaveBeenCalledWith(409);

    // …the original handler finishes (no 'finish' event after a disconnect)…
    aborted.statusCode = 201;
    aborted.json({ id: 'created-once' });
    await new Promise((r) => setImmediate(r));

    // …and the retry REPLAYS its result instead of running again.
    const retry = await run(reqFor());
    expect(retry.next).not.toHaveBeenCalled();
    expect(retry.res.headers['X-Idempotent-Replayed']).toBe('true');
  });

  it('a handler that fails after a disconnect releases the key (5xx), so a retry re-runs', async () => {
    const middleware = idempotencyMiddleware();
    const aborted = mockRes();
    const reqFor = () => mockReq({
      headers: { 'idempotency-key': 'abort-fail-key' },
      user: { organizationId: 'org-1', sub: 'user-a' },
      body: { n: 3 },
    });
    middleware(reqFor(), aborted, jest.fn());
    await new Promise((r) => setImmediate(r));
    aborted.writableFinished = false;
    aborted.emit('close');
    aborted.statusCode = 500;
    aborted.end('boom');
    await new Promise((r) => setImmediate(r));

    const retry = await run(reqFor(), 201, { id: 'second-try' });
    expect(retry.next).toHaveBeenCalledTimes(1);
  });

  it('reserves with the SHORT pending TTL, then caches the result with the full TTL', async () => {
    const calls: Array<{ op: string; ttl: number }> = [];
    const inner = createMemoryStore();
    const store = {
      get: inner.get,
      delete: inner.delete,
      reserve: async (k: string, e: any, ttl: number) => { calls.push({ op: 'reserve', ttl }); return inner.reserve(k, e, ttl); },
      set: async (k: string, e: any, ttl: number) => { calls.push({ op: 'set', ttl }); return inner.set(k, e, ttl); },
    };
    const res = mockRes();
    idempotencyMiddleware({ store })(mockReq({
      headers: { 'idempotency-key': 'ttl-key' }, user: { organizationId: 'org-1', sub: 'u' }, body: { n: 4 },
    }), res, jest.fn());
    await new Promise((r) => setImmediate(r));
    res.statusCode = 201;
    res.json({ ok: true });
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([{ op: 'reserve', ttl: 30 }, { op: 'set', ttl: 60 }]);
  });

  it('does not release on close when the response actually finished', async () => {
    const middleware = idempotencyMiddleware();
    const res = mockRes();
    const next = jest.fn();
    middleware(mockReq({
      headers: { 'idempotency-key': 'finished-key' },
      user: { organizationId: 'org-1', sub: 'user-a' },
      body: { n: 2 },
    }), res, next);
    await new Promise((r) => setImmediate(r));
    res.statusCode = 201;
    res.json({ id: 'done' });
    await new Promise((r) => setImmediate(r));

    // A normal request emits 'close' AFTER 'finish'; the cached success must survive.
    res.writableFinished = true;
    res.emit('close');
    await new Promise((r) => setImmediate(r));

    const replay = await run(mockReq({
      headers: { 'idempotency-key': 'finished-key' },
      user: { organizationId: 'org-1', sub: 'user-a' },
      body: { n: 2 },
    }));
    expect(replay.next).not.toHaveBeenCalled();
    expect(replay.res.headers['X-Idempotent-Replayed']).toBe('true');
  });
});

describe('idempotency key path and faithful replay', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  /** mockRes plus the header/type/write surface real Express responses have. */
  function richRes(): any {
    const res = mockRes();
    res.getHeader = jest.fn((name: string) => res.headers[name]);
    res.type = jest.fn((t: string) => { res.headers['Content-Type'] = t; return res; });
    res.write = jest.fn().mockReturnValue(true);
    return res;
  }
  async function first(req: any, complete: (res: any) => void): Promise<void> {
    const res = richRes();
    const middleware = idempotencyMiddleware({ store: store_ });
    middleware(req, res, jest.fn());
    await flush();
    complete(res);
    res.emit('finish');
    await flush();
  }
  async function retry(req: any): Promise<{ res: any; next: any }> {
    const res = richRes();
    const next = jest.fn();
    idempotencyMiddleware({ store: store_ })(req, res, next);
    await flush();
    return { res, next };
  }
  let store_: ReturnType<typeof createMemoryStore>;
  beforeEach(() => { store_ = createMemoryStore(); });

  it('keys on the CONCRETE path, not the route pattern (/:id)', async () => {
    const key = 'k-path';
    await first(mockReq({ method: 'DELETE', headers: { 'idempotency-key': key }, baseUrl: '/pipelines', path: '/a', route: { path: '/:id' } }),
      (res) => { res.json({ deleted: 'a' }); });
    const other = await retry(mockReq({ method: 'DELETE', headers: { 'idempotency-key': key }, baseUrl: '/pipelines', path: '/b', route: { path: '/:id' } }));
    expect(other.next).toHaveBeenCalled();
    const same = await retry(mockReq({ method: 'DELETE', headers: { 'idempotency-key': key }, baseUrl: '/pipelines', path: '/a', route: { path: '/:id' } }));
    expect(same.next).not.toHaveBeenCalled();
    expect(same.res.json).toHaveBeenCalledWith({ deleted: 'a' });
  });

  it('replays a string body verbatim with its content type (not JSON-encoded)', async () => {
    const req = () => mockReq({ headers: { 'idempotency-key': 'k-str' }, path: '/s' });
    await first(req(), (res) => {
      res.headers['Content-Type'] = 'text/csv; charset=utf-8';
      res.send('a,b\n1,2');
      res.end('a,b\n1,2');
    });
    const { res, next } = await retry(req());
    expect(next).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.type).toHaveBeenCalledWith('text/csv; charset=utf-8');
    expect(res.send).toHaveBeenCalledWith('a,b\n1,2');
  });

  it('replays a Buffer body as the same bytes', async () => {
    const req = () => mockReq({ headers: { 'idempotency-key': 'k-buf' }, path: '/b' });
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    await first(req(), (res) => {
      res.headers['Content-Type'] = 'application/octet-stream';
      res.send(bytes);
      res.end(bytes);
    });
    const { res } = await retry(req());
    expect(res.json).not.toHaveBeenCalled();
    const sent = res.send.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(sent)).toBe(true);
    expect(sent.equals(bytes)).toBe(true);
  });

  it('round-trips a Buffer body through the Redis store (JSON storage)', async () => {
    const map = new Map<string, string>();
    store_ = createRedisIdempotencyStore({
      get: async (k: string) => map.get(k) ?? null,
      set: async (k: string, v: string, ...args: (string | number)[]) => {
        if (args.includes('NX') && map.has(k)) return null;
        map.set(k, v); return 'OK';
      },
      del: async (k: string) => (map.delete(k) ? 1 : 0),
    });
    const req = () => mockReq({ headers: { 'idempotency-key': 'k-buf-redis' }, path: '/b' });
    const bytes = Buffer.from('binary\u0000data');
    await first(req(), (res) => { res.send(bytes); res.end(bytes); });
    const { res } = await retry(req());
    expect((res.send.mock.calls[0][0] as Buffer).equals(bytes)).toBe(true);
  });

  it('does not cache a streamed (res.write / SSE) response — the retry runs fresh', async () => {
    const req = () => mockReq({ headers: { 'idempotency-key': 'k-sse' }, path: '/stream' });
    await first(req(), (res) => {
      res.headers['Content-Type'] = 'text/event-stream';
      res.write('data: 1\n\n');
      res.write('data: 2\n\n');
      res.end();
    });
    const { res, next } = await retry(req());
    expect(next).toHaveBeenCalled();
    expect(res.headers['X-Idempotent-Replayed']).not.toBe('true');
  });

  it('replays an empty 204 as an empty response', async () => {
    const req = () => mockReq({ headers: { 'idempotency-key': 'k-204' }, path: '/e' });
    await first(req(), (res) => { res.status(204); res.end(); });
    const { res } = await retry(req());
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.json).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });
});
