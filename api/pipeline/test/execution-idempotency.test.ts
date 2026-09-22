// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the short server-side execution idempotency window. The window
 * refuses a second CodePipeline trigger for the same (orgId, pipelineId) inside a
 * short TTL so a double-submit can't launch two runs. Backed by an atomic Redis
 * `SET … NX`; fails OPEN when Redis is unconfigured/unreachable.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { createExecutionIdempotencyGuard } = await import('../src/services/execution-idempotency.js');

/** Fake ioredis: `SET … NX` per-key once, and a Lua compare-and-delete release. */
function fakeRedis() {
  const keys = new Map<string, string>();
  const set = jest.fn(async (key: string, val: string, ..._args: (string | number)[]) => {
    if (keys.has(key)) return null; // NX refused — key present
    keys.set(key, val);
    return 'OK';
  });
  const evalFn = jest.fn(async (_script: string, _n: number, key: string | number, token: string | number) => {
    if (keys.get(String(key)) === String(token)) { keys.delete(String(key)); return 1; }
    return 0;
  });
  return { set, eval: evalFn, keys };
}

describe('execution idempotency window', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('first claim for a (org, pipeline) wins; a second inside the window is refused', async () => {
    const redis = fakeRedis();
    const guard = createExecutionIdempotencyGuard(redis, 10);

    await expect(guard.claim('acme', 'p-1')).resolves.toEqual({ token: expect.any(String) });
    await expect(guard.claim('acme', 'p-1')).resolves.toBeNull();
  });

  it('claims for different pipelines / orgs are independent', async () => {
    const redis = fakeRedis();
    const guard = createExecutionIdempotencyGuard(redis, 10);

    await expect(guard.claim('acme', 'p-1')).resolves.not.toBeNull();
    await expect(guard.claim('acme', 'p-2')).resolves.not.toBeNull(); // different pipeline
    await expect(guard.claim('beta', 'p-1')).resolves.not.toBeNull(); // different org
  });

  it('issues an atomic SET … EX <ttl> NX with a per-(org,pipeline) key and a unique token', async () => {
    const redis = fakeRedis();
    const guard = createExecutionIdempotencyGuard(redis, 30);

    const claim = await guard.claim('acme', 'p-1');
    expect(redis.set).toHaveBeenCalledWith('pipeline-exec:acme:p-1', claim!.token!, 'EX', 30, 'NX');
  });

  it('release frees only its OWN claim — never a later trigger\u2019s window', async () => {
    const redis = fakeRedis();
    const guard = createExecutionIdempotencyGuard(redis, 10);
    const stale = await guard.claim('acme', 'p-1');
    // Our window expired and a newer trigger claimed it.
    redis.keys.set('pipeline-exec:acme:p-1', 'someone-elses-token');
    await guard.release('acme', 'p-1', stale!);
    expect(redis.keys.get('pipeline-exec:acme:p-1')).toBe('someone-elses-token');

    redis.keys.clear();
    const mine = await guard.claim('acme', 'p-1');
    await guard.release('acme', 'p-1', mine!);
    expect(redis.keys.has('pipeline-exec:acme:p-1')).toBe(false);
  });

  it('fails OPEN (claim succeeds) when Redis is not configured', async () => {
    const guard = createExecutionIdempotencyGuard(null);
    await expect(guard.claim('acme', 'p-1')).resolves.toEqual({ token: null });
    await expect(guard.claim('acme', 'p-1')).resolves.toEqual({ token: null }); // no dedup without redis
  });

  it('fails OPEN when the Redis call throws (transient outage never blocks a trigger)', async () => {
    const redis = { set: jest.fn(async () => { throw new Error('ECONNREFUSED'); }), eval: jest.fn(async () => 0) };
    const guard = createExecutionIdempotencyGuard(redis, 10);
    await expect(guard.claim('acme', 'p-1')).resolves.toEqual({ token: null });
  });
});
