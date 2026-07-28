// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: {
    IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60000,
    IDEMPOTENCY_TTL_MS: 60000,
    IDEMPOTENCY_MAX_STORE_SIZE: 1000,
  },
}));

const { idempotencyMiddleware } = await import('../src/api/idempotency-middleware.js');

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
});
