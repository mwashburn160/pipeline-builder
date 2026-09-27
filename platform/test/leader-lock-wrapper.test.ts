// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * runWithLeaderLock (utils/leader-lock.ts) NEVER rejects.
 *
 * Every platform sweep fires it from a timer with `void`, so a rejection is an
 * unhandled promise rejection — which exits the process. That is exactly how
 * platform crash-looped on minikube: the first sweep's lock SET ran before the
 * Redis connection was up.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetRedisClient = jest.fn<() => Promise<unknown>>();
const mockLoggerError = jest.fn<AnyFn>();
const mockWithLeaderLock = jest.fn<(...a: any[]) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ info: jest.fn<AnyFn>(), warn: jest.fn<AnyFn>(), error: mockLoggerError, debug: jest.fn<AnyFn>() }),
  withLeaderLock: (...a: any[]) => mockWithLeaderLock(...a),
}));
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: () => mockGetRedisClient(),
}));

const { runWithLeaderLock, createLockedSweep } = await import('../src/utils/leader-lock.js');

beforeEach(() => {
  jest.clearAllMocks();
  // Behave like api-core: run fn when "acquired", handing it a live run object.
  mockWithLeaderLock.mockImplementation(async (_r: unknown, _k: string, _t: number, fn: (run: { signal: AbortSignal }) => Promise<void>) => {
    await fn({ signal: new AbortController().signal });
    return true;
  });
});

describe('runWithLeaderLock', () => {
  it('logs a failing job instead of rejecting (Redis configured)', async () => {
    mockGetRedisClient.mockResolvedValue({});
    await expect(runWithLeaderLock('platform:leader:x', 1000, async () => { throw new Error('mongo down'); }))
      .resolves.toBe(true);
    expect(mockLoggerError).toHaveBeenCalledWith('Background job failed', expect.objectContaining({ key: 'platform:leader:x', error: 'mongo down' }));
  });

  it('logs a failing job instead of rejecting when it DOES run without Redis', async () => {
    // Only a sweep that declares itself concurrency-safe runs without a lock.
    mockGetRedisClient.mockResolvedValue(undefined);
    await expect(runWithLeaderLock('platform:leader:x', 1000, async () => { throw new Error('boom'); }, { concurrencySafe: true }))
      .resolves.toBe(true);
    expect(mockLoggerError).toHaveBeenCalled();
  });

  /**
   * FAIL CLOSED without Redis. The wrapper used to run every body on every pod
   * and justify it with "the sweeps' own idempotency keeps it safe" — which was
   * not true of org-purge, whose cascade has no atomic claim across replicas.
   * A sweep now has to say it is safe.
   */
  it('SKIPS a sweep that has not declared itself concurrency-safe when Redis is unset', async () => {
    mockGetRedisClient.mockResolvedValue(undefined);
    const run = jest.fn(async () => undefined);
    await expect(runWithLeaderLock('platform:leader:x', 1000, run)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    // A skip is not an error — it is a misconfiguration, reported as a warning
    // plus a counter an operator can alert on.
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('never rejects, whichever path it takes', async () => {
    // Every caller fires this from a timer with `void`, so a rejection would be an
    // unhandled rejection — which exits the process. That is how platform
    // crash-looped on minikube when the first sweep beat the Redis connection.
    mockGetRedisClient.mockResolvedValue(undefined);
    await expect(runWithLeaderLock('k', 1000, async () => { throw new Error('x'); })).resolves.toBe(false);
    // Including when resolving the Redis client itself throws — a Sentinel lookup
    // failing must not take the process down, it must degrade to "no lock".
    mockGetRedisClient.mockRejectedValue(new Error('redis resolution exploded'));
    await expect(runWithLeaderLock('k', 1000, async () => undefined, { concurrencySafe: true })).resolves.toBe(true);
    await expect(runWithLeaderLock('k', 1000, async () => undefined)).resolves.toBe(false);
  });
});

describe('createLockedSweep', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('runs each cycle under the leader lock with a crash-recovery TTL, not one derived from the interval', async () => {
    mockGetRedisClient.mockResolvedValue({});
    const run = jest.fn(async () => undefined);
    const sweep = createLockedSweep({ name: 't', lockKey: 'platform:leader:t', intervalMs: 1000, run });
    sweep.start();
    await jest.advanceTimersByTimeAsync(0);
    // The TTL was `max(intervalMs, 60s)`, which made the 24-hour domain-reverify
    // sweep hold a 24-HOUR lock — a dead pod parked it for a day. The holder
    // heartbeats for as long as the run takes, so the TTL only bounds crash
    // recovery and is a flat 120s regardless of interval.
    expect(mockWithLeaderLock).toHaveBeenCalledWith(
      expect.anything(), 'platform:leader:t', 120_000, expect.any(Function), expect.objectContaining({ signal: expect.anything() }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    sweep.stop();
  });

  it('never overlaps itself on one pod when a cycle outlasts the interval', async () => {
    // No Redis, so the sweep must declare itself safe to run unlocked — this test
    // is about the SAME-pod re-entrancy guard, not the cross-pod lock.
    mockGetRedisClient.mockResolvedValue(undefined);
    let release!: () => void;
    const run = jest.fn(() => new Promise<void>((r) => { release = r; }));
    const sweep = createLockedSweep({ name: 't', lockKey: 'platform:leader:t', intervalMs: 1000, run, concurrencySafe: true });
    sweep.start();
    await jest.advanceTimersByTimeAsync(3500);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    sweep.stop();
  });

  it('passes the scheduler shutdown signal down, so stop() can release the lock', async () => {
    mockGetRedisClient.mockResolvedValue({});
    const sweep = createLockedSweep({ name: 't', lockKey: 'platform:leader:t', intervalMs: 1000, run: async () => undefined });
    sweep.start();
    await jest.advanceTimersByTimeAsync(0);
    const opts = mockWithLeaderLock.mock.calls[0]![4] as { signal?: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal!.aborted).toBe(false);
    sweep.stop();
    // Aborted on stop: a signal-aware body returns and withLeaderLock releases,
    // instead of the key lingering for the rest of the TTL after a rolling deploy.
    expect(opts.signal!.aborted).toBe(true);
  });
});
