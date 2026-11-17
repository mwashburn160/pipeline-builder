// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A limiter's shared store failing must be VISIBLE: every store error is counted
 * on `rate_limit_store_error_total{limiter}` before express-rate-limit lets the
 * request through (`passOnStoreError`) — without the count, a Redis outage
 * silently turns every limiter off. The pass-through itself is unchanged.
 */

import type { AddressInfo } from 'net';
import { jest, describe, it, expect, afterAll, beforeAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import express from 'express';
import type { Store } from 'express-rate-limit';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const mockIncCounter = jest.fn();
let storeFails = true;
const hits = new Map<string, number>();
const fakeStore = (): Store => ({
  init: jest.fn<(o: unknown) => void>(),
  increment: async (key: string) => {
    if (storeFails) throw new Error('redis down');
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    return { totalHits: n, resetTime: new Date(Date.now() + 60_000) };
  },
  decrement: async () => { if (storeFails) throw new Error('redis down'); },
  resetKey: async () => { if (storeFails) throw new Error('redis down'); },
  get: async () => { if (storeFails) throw new Error('redis down'); return undefined; },
  prefix: 'rl:test:',
});

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  createSharedRateLimitStore: () => fakeStore(),
}));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));

const { createLimiter, withStoreErrorCounting, RATE_LIMIT_STORE_ERROR_METRIC } = await import('../src/middleware/rate-limiter.js');

let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const app = express();
  app.use('/x', createLimiter({ name: 'probe', windowMs: 60_000, max: 1, keyGenerator: () => 'k', message: 'slow down' }));
  app.get('/x', (_req, res) => { res.status(200).json({ ok: true }); });
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { mockIncCounter.mockClear(); hits.clear(); });

describe('createLimiter — shared-store failures', () => {
  it('lets the request through AND counts the store error under the limiter name', async () => {
    storeFails = true;
    const res = await fetch(`${base}/x`);
    expect(res.status).toBe(200);
    expect(mockIncCounter).toHaveBeenCalledWith(RATE_LIMIT_STORE_ERROR_METRIC, { limiter: 'probe' });
  });

  it('counts nothing while the store is healthy, and still enforces the limit', async () => {
    storeFails = false;
    expect((await fetch(`${base}/x`)).status).toBe(200);
    expect((await fetch(`${base}/x`)).status).toBe(429);
    expect(mockIncCounter).not.toHaveBeenCalledWith(RATE_LIMIT_STORE_ERROR_METRIC, expect.anything());
    expect(mockIncCounter).toHaveBeenCalledWith('platform_rate_limit_rejected_total', expect.objectContaining({ limiter: 'probe' }));
  });
});

describe('withStoreErrorCounting', () => {
  it('counts and re-throws on every method, forwarding init and prefix', async () => {
    storeFails = true;
    const inner = fakeStore();
    const wrapped = withStoreErrorCounting(inner, 'w');
    expect(wrapped.prefix).toBe('rl:test:');
    void wrapped.init?.({} as never);
    expect(inner.init).toHaveBeenCalled();
    await expect(wrapped.increment('a')).rejects.toThrow('redis down');
    await expect(wrapped.decrement('a')).rejects.toThrow('redis down');
    await expect(wrapped.resetKey('a')).rejects.toThrow('redis down');
    await expect(wrapped.get!('a')).rejects.toThrow('redis down');
    expect(mockIncCounter).toHaveBeenCalledTimes(4);
  });

  it('advertises no optional method the wrapped store lacks', () => {
    const minimal: Store = { increment: async () => ({ totalHits: 1, resetTime: undefined }), decrement: async () => {}, resetKey: async () => {} };
    const wrapped = withStoreErrorCounting(minimal, 'm');
    expect('get' in wrapped).toBe(false);
    expect('init' in wrapped).toBe(false);
    expect('prefix' in wrapped).toBe(false);
  });

  it('a missing metrics registry never turns a store error into a different failure', async () => {
    mockIncCounter.mockImplementationOnce(() => { throw new Error('no registry'); });
    storeFails = true;
    await expect(withStoreErrorCounting(fakeStore(), 'n').increment('a')).rejects.toThrow('redis down');
  });
});
