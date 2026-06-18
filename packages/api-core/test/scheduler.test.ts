// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createScheduler } from '../src/services/scheduler.js';

describe('createScheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('runs once on start, then every interval, and stops cleanly', async () => {
    const run = jest.fn<() => Promise<void>>(async () => {});
    const s = createScheduler({ name: 'test', intervalMs: 1000, run });
    s.start();
    expect(run).toHaveBeenCalledTimes(1); // runOnStart
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
    s.stop();
    await jest.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(3); // nothing after stop
  });

  it('runOnStart:false defers the first run to the interval', async () => {
    const run = jest.fn<() => Promise<void>>(async () => {});
    const s = createScheduler({ name: 'test', intervalMs: 1000, run, runOnStart: false });
    s.start();
    expect(run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('start is idempotent (a second call does not add a second timer)', async () => {
    const run = jest.fn<() => Promise<void>>(async () => {});
    const s = createScheduler({ name: 'test', intervalMs: 1000, run });
    s.start();
    s.start();
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2); // not 3 (single timer)
    s.stop();
  });

  it('honours startupDelayMs before the first run, and stop() during the delay cancels it', async () => {
    const run = jest.fn<() => Promise<void>>(async () => {});
    const s = createScheduler({ name: 'test', intervalMs: 1000, run, startupDelayMs: 5000 });
    s.start();
    await jest.advanceTimersByTimeAsync(4999);
    expect(run).not.toHaveBeenCalled();
    s.stop(); // cancels the pending startup before it fires
    await jest.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
  });

  it('a throwing cycle is isolated — the loop keeps running', async () => {
    const run = jest.fn<() => Promise<void>>(async () => { throw new Error('boom'); });
    const s = createScheduler({ name: 'test', intervalMs: 1000, run });
    s.start();
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3); // start + 2 intervals, despite throwing
    s.stop();
  });

  it('with a lock, runs the cycle only when the lock is acquired', async () => {
    const acquired = { set: jest.fn(async () => 'OK'), get: jest.fn(async () => null), del: jest.fn(async () => 1) };
    const run = jest.fn<() => Promise<void>>(async () => {});
    const s = createScheduler({ name: 'test', intervalMs: 1000, run, lock: { redis: () => acquired, key: 'k', ttlMs: 500 } });
    s.start();
    await jest.advanceTimersByTimeAsync(0); // flush the async lock+cycle
    expect(acquired.set).toHaveBeenCalledWith('k', expect.any(String), 'PX', 500, 'NX');
    expect(run).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('with a lock, skips the cycle when another holder owns it (SET NX → null)', async () => {
    const contended = { set: jest.fn(async () => null), get: jest.fn(async () => null), del: jest.fn(async () => 1) };
    const run = jest.fn<() => Promise<void>>(async () => {});
    const s = createScheduler({ name: 'test', intervalMs: 1000, run, lock: { redis: () => contended, key: 'k', ttlMs: 500 } });
    s.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    s.stop();
  });
});
