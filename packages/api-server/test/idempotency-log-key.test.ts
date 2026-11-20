// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The idempotency store key embeds the org id, the user id and the client's
 * Idempotency-Key. None of that belongs in a log line, so the middleware logs a
 * SHA-256 of the store key (enough to correlate one key's lines) instead.
 */
import { createHash } from 'crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createLogger: () => logger }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: {
    IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60000,
    IDEMPOTENCY_TTL_MS: 60000,
    IDEMPOTENCY_PENDING_TTL_MS: 30000,
    IDEMPOTENCY_MAX_STORE_SIZE: 1000,
  },
}));

const { idempotencyMiddleware, setIdempotencyStore, createMemoryStore } = await import('../src/api/idempotency-middleware.js');

const ORG = 'org-secret-7f3a';
const USER = 'user-secret-91bc';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function mockReq(key: string): any {
  return { method: 'POST', baseUrl: '/api', path: '/things', headers: { 'idempotency-key': key }, user: { organizationId: ORG, sub: USER }, body: { a: 1 } };
}
function mockRes(): any {
  const res: any = { statusCode: 201, headersSent: false, headers: {} };
  res.setHeader = jest.fn();
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  res.on = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  setIdempotencyStore(createMemoryStore());
});

describe('idempotency middleware logging', () => {
  it('logs a hash of the store key at debug level, never the org id, user id or client key', async () => {
    const key = 'client-key-' + Math.random();
    const middleware = idempotencyMiddleware();

    middleware(mockReq(key), mockRes(), jest.fn());
    await flush();
    // A concurrent duplicate while the first is in flight — logged at debug.
    middleware(mockReq(key), mockRes(), jest.fn());
    await flush();

    expect(logger.debug).toHaveBeenCalled();
    const lines = JSON.stringify([...logger.debug.mock.calls, ...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(lines).not.toContain(ORG);
    expect(lines).not.toContain(USER);
    expect(lines).not.toContain(key);

    const meta = logger.debug.mock.calls[0][1] as Record<string, unknown>;
    expect(meta).not.toHaveProperty('key');
    expect(meta.keyHash).toMatch(/^[0-9a-f]{16,64}$/);
  });

  it('the same store key always logs the same hash (so its lines correlate)', async () => {
    const key = 'client-key-' + Math.random();
    const middleware = idempotencyMiddleware();
    middleware(mockReq(key), mockRes(), jest.fn());
    await flush();
    middleware(mockReq(key), mockRes(), jest.fn());
    await flush();
    middleware(mockReq(key), mockRes(), jest.fn());
    await flush();
    const hashes = logger.debug.mock.calls.map((c) => (c[1] as { keyHash?: string }).keyHash);
    expect(hashes.length).toBeGreaterThanOrEqual(2);
    expect(hashes[0]).toMatch(/^[0-9a-f]{16,64}$/);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).not.toBe(createHash('sha256').update(key).digest('hex'));
  });
});
