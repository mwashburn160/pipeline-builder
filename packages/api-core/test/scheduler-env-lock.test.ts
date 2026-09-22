// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

let envClient: Record<string, jest.Mock> | null = null;
const createEnvRedisClient = jest.fn(() => envClient);

jest.unstable_mockModule('../src/services/env-redis.js', () => ({
  createEnvRedisClient,
  whenRedisReady: async () => undefined,
}));

const { createScheduler } = await import('../src/services/scheduler.js');

function fakeClient(): Record<string, jest.Mock> {
  return {
    set: jest.fn(async () => 'OK'),
    get: jest.fn(async () => null),
    del: jest.fn(async () => 1),
    quit: jest.fn(async () => 'OK'),
  };
}

describe('createScheduler — shared env lock client', () => {
  beforeEach(() => { jest.useFakeTimers(); createEnvRedisClient.mockClear(); envClient = fakeClient(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('shares ONE env client across locked schedulers and closes it when the last stops', async () => {
    const runA = jest.fn(async () => {});
    const runB = jest.fn(async () => {});
    const a = createScheduler({ name: 'a', intervalMs: 1000, run: runA, lock: { key: 'a', ttlMs: 500 } });
    const b = createScheduler({ name: 'b', intervalMs: 1000, run: runB, lock: { key: 'b', ttlMs: 500 } });
    a.start();
    b.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(createEnvRedisClient).toHaveBeenCalledTimes(1);
    expect(envClient!.set).toHaveBeenCalledWith('a', expect.any(String), 'PX', 500, 'NX');
    expect(envClient!.set).toHaveBeenCalledWith('b', expect.any(String), 'PX', 500, 'NX');
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);

    a.stop();
    await jest.advanceTimersByTimeAsync(0);
    expect(envClient!.quit).not.toHaveBeenCalled();
    b.stop();
    await jest.advanceTimersByTimeAsync(0);
    expect(envClient!.quit).toHaveBeenCalledTimes(1);
  });

  it('runs unlocked on every pod when Redis is not configured', async () => {
    envClient = null;
    const run = jest.fn(async () => {});
    const s = createScheduler({ name: 'c', intervalMs: 1000, run, lock: { key: 'c', ttlMs: 500 } });
    s.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('a scheduler with its own client never touches the shared env client', async () => {
    const own = fakeClient();
    const s = createScheduler({ name: 'd', intervalMs: 1000, run: async () => {}, lock: { key: 'd', ttlMs: 500, redis: () => own as never } });
    s.start();
    await jest.advanceTimersByTimeAsync(0);
    s.stop();
    expect(createEnvRedisClient).not.toHaveBeenCalled();
    expect(own.set).toHaveBeenCalled();
  });
});
