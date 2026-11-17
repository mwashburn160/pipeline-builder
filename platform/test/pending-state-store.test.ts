// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `createPendingStateStore().putIfAbsent` is the SAML replay guard
 * (helpers/pending-state-store.ts). It must be ATOMIC and FAIL CLOSED: with
 * Redis configured the fleet shares one replay record, so a Redis error answers
 * "already claimed" instead of falling back to a pod-local map the other
 * replicas cannot see. The local map is the store only when Redis is unset.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

let redis: { set: jest.Mock } | null = null;
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({ getRedisClient: async () => redis }));

const { createPendingStateStore, PENDING_STATE_UNAVAILABLE } = await import('../src/helpers/pending-state-store.js');

const store = () => createPendingStateStore<{ n: number }>({ prefix: 't:', ttlMs: 60_000, cleanupIntervalMs: 60_000, maxEntries: 100 });

beforeEach(() => { redis = null; });

describe('putIfAbsent — replay guard', () => {
  it('claims once through Redis (SET NX), refusing the second claimant', async () => {
    const set = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    redis = { set } as never;
    const s = store();
    await expect(s.putIfAbsent('id-1', { n: 1 })).resolves.toBe(true);
    await expect(s.putIfAbsent('id-1', { n: 1 })).resolves.toBe(false);
    expect(set).toHaveBeenCalledWith('t:id-1', JSON.stringify({ n: 1 }), 'PX', 60_000, 'NX');
  });

  it('FAILS CLOSED on a Redis error — never the pod-local map', async () => {
    redis = { set: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('down')) } as never;
    const s = store();
    await expect(s.putIfAbsent('id-1', { n: 1 })).resolves.toBe(false);
    // Nothing leaked into the local map: once Redis is gone entirely, the id is
    // still unclaimed there.
    redis = null;
    await expect(s.putIfAbsent('id-1', { n: 1 })).resolves.toBe(true);
  });

  it('uses the local map only when Redis is not configured', async () => {
    const s = store();
    await expect(s.putIfAbsent('id-2', { n: 2 })).resolves.toBe(true);
    await expect(s.putIfAbsent('id-2', { n: 2 })).resolves.toBe(false);
    s._stopSweepForTests();
  });
});

describe('put — production fails closed', () => {
  const prevEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = prevEnv; });

  it('THROWS PENDING_STATE_UNAVAILABLE on a Redis error in production — never the pod-local map', async () => {
    process.env.NODE_ENV = 'production';
    redis = { set: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('down')) } as never;
    const s = store();
    await expect(s.put('st-1', { n: 1 })).rejects.toThrow(PENDING_STATE_UNAVAILABLE);
    // Nothing was written locally.
    redis = null;
    process.env.NODE_ENV = 'test';
    await expect(s.consume('st-1')).resolves.toBeNull();
    s._stopSweepForTests();
  });

  it('THROWS in production when no Redis client exists at all', async () => {
    process.env.NODE_ENV = 'production';
    const s = store();
    await expect(s.put('st-2', { n: 2 })).rejects.toThrow(PENDING_STATE_UNAVAILABLE);
    s._stopSweepForTests();
  });

  it('putIfAbsent refuses in production when no Redis client exists', async () => {
    process.env.NODE_ENV = 'production';
    const s = store();
    await expect(s.putIfAbsent('id-3', { n: 3 })).resolves.toBe(false);
    s._stopSweepForTests();
  });

  it('outside production a Redis error on put still falls back locally (same-pod callback works)', async () => {
    process.env.NODE_ENV = 'test';
    redis = { set: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('down')) } as never;
    const s = store();
    await s.put('st-4', { n: 4 });
    redis = null;
    await expect(s.consume('st-4')).resolves.toEqual({ n: 4 });
    s._stopSweepForTests();
  });
});
