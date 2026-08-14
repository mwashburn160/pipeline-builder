// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the short server-side execution idempotency window (D1). The window
 * refuses a second CodePipeline trigger for the same (orgId, pipelineId) inside a
 * short TTL so a double-submit can't launch two runs. Backed by an atomic Redis
 * `SET … NX`; fails OPEN when Redis is unconfigured/unreachable.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { createExecutionIdempotencyGuard } = await import('../src/services/execution-idempotency.js');

/** Fake ioredis whose `set … NX` behaves like the real server (per-key once). */
function fakeRedis() {
  const keys = new Set<string>();
  const set = jest.fn(async (key: string, _val: string, ..._args: (string | number)[]) => {
    if (keys.has(key)) return null; // NX refused — key present
    keys.add(key);
    return 'OK';
  });
  return { set, keys };
}

describe('execution idempotency window', () => {
  beforeEach(() => jest.clearAllMocks());

  it('first claim for a (org, pipeline) wins; a second inside the window is refused', async () => {
    const redis = fakeRedis();
    const guard = createExecutionIdempotencyGuard(redis, 10);

    await expect(guard.claim('acme', 'p-1')).resolves.toBe(true);
    await expect(guard.claim('acme', 'p-1')).resolves.toBe(false);
  });

  it('claims for different pipelines / orgs are independent', async () => {
    const redis = fakeRedis();
    const guard = createExecutionIdempotencyGuard(redis, 10);

    await expect(guard.claim('acme', 'p-1')).resolves.toBe(true);
    await expect(guard.claim('acme', 'p-2')).resolves.toBe(true); // different pipeline
    await expect(guard.claim('beta', 'p-1')).resolves.toBe(true); // different org
  });

  it('issues an atomic SET … EX <ttl> NX with a per-(org,pipeline) key', async () => {
    const redis = fakeRedis();
    const guard = createExecutionIdempotencyGuard(redis, 30);

    await guard.claim('acme', 'p-1');
    expect(redis.set).toHaveBeenCalledWith(
      'pipeline-exec:acme:p-1', '1', 'EX', 30, 'NX',
    );
  });

  it('fails OPEN (claim succeeds) when Redis is not configured', async () => {
    const guard = createExecutionIdempotencyGuard(null);
    await expect(guard.claim('acme', 'p-1')).resolves.toBe(true);
    await expect(guard.claim('acme', 'p-1')).resolves.toBe(true); // no dedup without redis
  });

  it('fails OPEN when the Redis call throws (transient outage never blocks a trigger)', async () => {
    const redis = { set: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    const guard = createExecutionIdempotencyGuard(redis, 10);
    await expect(guard.claim('acme', 'p-1')).resolves.toBe(true);
  });
});
