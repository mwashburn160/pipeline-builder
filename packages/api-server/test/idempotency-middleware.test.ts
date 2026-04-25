// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: {
    IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60000,
    IDEMPOTENCY_TTL_MS: 60000,
    IDEMPOTENCY_MAX_STORE_SIZE: 1000,
  },
}));

import { idempotencyMiddleware } from '../src/api/idempotency-middleware';

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
  };
  res.setHeader = jest.fn((name: string, value: string) => { res.headers[name] = value; });
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn().mockReturnValue(res);
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

  it('intercepts res.json on first call with key', () => {
    const middleware = idempotencyMiddleware();
    const req = mockReq({ headers: { 'idempotency-key': 'fresh-key-1' } });
    const res = mockRes();
    const originalJson = res.json;
    middleware(req, res, jest.fn());
    expect(res.json).not.toBe(originalJson);
  });

  it('replays cached response on second call with same key', () => {
    const middleware = idempotencyMiddleware();
    const key = 'cache-key-' + Math.random();

    // First call — caches response
    const req1 = mockReq({ headers: { 'idempotency-key': key } });
    const res1 = mockRes();
    res1.statusCode = 201;
    middleware(req1, res1, jest.fn());
    res1.json({ id: 'created' });

    // Second call — should replay from cache
    const req2 = mockReq({ headers: { 'idempotency-key': key } });
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.setHeader).toHaveBeenCalledWith('X-Idempotent-Replayed', 'true');
    expect(res2.status).toHaveBeenCalledWith(201);
    expect(res2.json).toHaveBeenCalledWith({ id: 'created' });
  });

  it('namespaces cache by orgId to prevent cross-org collisions', () => {
    const middleware = idempotencyMiddleware();
    const key = 'shared-key-' + Math.random();

    // Org A caches
    const reqA = mockReq({
      headers: { 'idempotency-key': key },
      context: { identity: { orgId: 'org-a' } },
    });
    const resA = mockRes();
    middleware(reqA, resA, jest.fn());
    resA.json({ for: 'a' });

    // Org B sees no cached entry
    const reqB = mockReq({
      headers: { 'idempotency-key': key },
      context: { identity: { orgId: 'org-b' } },
    });
    const resB = mockRes();
    const nextB = jest.fn();
    middleware(reqB, resB, nextB);
    expect(nextB).toHaveBeenCalled();
  });
});
