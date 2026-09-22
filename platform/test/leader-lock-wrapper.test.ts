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
  // Behave like api-core: run fn when "acquired".
  mockWithLeaderLock.mockImplementation(async (_r: unknown, _k: string, _t: number, fn: () => Promise<void>) => { await fn(); return true; });
});

describe('runWithLeaderLock', () => {
  it('logs a failing job instead of rejecting (Redis configured)', async () => {
    mockGetRedisClient.mockResolvedValue({});
    await expect(runWithLeaderLock('platform:leader:x', 1000, async () => { throw new Error('mongo down'); }))
      .resolves.toBe(true);
    expect(mockLoggerError).toHaveBeenCalledWith('Background job failed', expect.objectContaining({ key: 'platform:leader:x', error: 'mongo down' }));
  });

  it('logs a failing job instead of rejecting (no Redis)', async () => {
    mockGetRedisClient.mockResolvedValue(undefined);
    await expect(runWithLeaderLock('platform:leader:x', 1000, async () => { throw new Error('boom'); }))
      .resolves.toBe(true);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

describe('createLockedSweep', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('runs each cycle under the leader lock with a TTL floored at 60s', async () => {
    mockGetRedisClient.mockResolvedValue({});
    const run = jest.fn(async () => undefined);
    const sweep = createLockedSweep({ name: 't', lockKey: 'platform:leader:t', intervalMs: 1000, run });
    sweep.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockWithLeaderLock).toHaveBeenCalledWith(expect.anything(), 'platform:leader:t', 60_000, expect.any(Function));
    expect(run).toHaveBeenCalledTimes(1);
    sweep.stop();
  });

  it('never overlaps itself on one pod when a cycle outlasts the interval', async () => {
    mockGetRedisClient.mockResolvedValue(undefined);
    let release!: () => void;
    const run = jest.fn(() => new Promise<void>((r) => { release = r; }));
    const sweep = createLockedSweep({ name: 't', lockKey: 'platform:leader:t', intervalMs: 1000, run });
    sweep.start();
    await jest.advanceTimersByTimeAsync(3500);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    sweep.stop();
  });
});
