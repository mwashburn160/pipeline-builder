// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createScheduler } from '../src/services/scheduler.js';
import { resetGaugeEmitter, setGaugeEmitter } from '../src/utils/metric-emitter.js';

describe('createScheduler', () => {
  beforeEach(() => { jest.useFakeTimers(); });
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
    const acquired = { set: jest.fn(async (..._args: unknown[]) => 'OK'), get: jest.fn(async () => null), del: jest.fn(async () => 1) };
    const run = jest.fn<() => Promise<void>>(async () => {});
    const s = createScheduler({ name: 'test', intervalMs: 1000, run, lock: { redis: () => acquired, key: 'k', ttlMs: 500 } });
    s.start();
    await jest.advanceTimersByTimeAsync(0); // flush the async lock+cycle
    expect(acquired.set).toHaveBeenCalledWith('k', expect.any(String), 'PX', 500, 'NX');
    expect(run).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('with a lock, skips the cycle when another holder owns it (SET NX → null)', async () => {
    const contended = { set: jest.fn(async (..._args: unknown[]) => null), get: jest.fn(async () => null), del: jest.fn(async () => 1) };
    const run = jest.fn<() => Promise<void>>(async () => {});
    const s = createScheduler({ name: 'test', intervalMs: 1000, run, lock: { redis: () => contended, key: 'k', ttlMs: 500 } });
    s.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    s.stop();
  });
});

describe('createScheduler liveness gauges', () => {
  type Set = { name: string; labels: Record<string, string>; value: number };
  let sets: Set[];
  const named = (n: string) => sets.filter((g) => g.name === n);

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    sets = [];
    setGaugeEmitter((name, labels, value) => { sets.push({ name, labels, value }); });
  });
  afterEach(() => { resetGaugeEmitter(); jest.clearAllTimers(); jest.useRealTimers(); });

  it('publishes the interval and the start time on start, keyed by the lock key', () => {
    const redis = { set: jest.fn(async (..._a: unknown[]) => 'OK'), get: jest.fn(async () => null), del: jest.fn(async () => 1) };
    const s = createScheduler({ name: 'job', intervalMs: 6 * 3600_000, run: async () => {}, runOnStart: false, lock: { redis: () => redis, key: 'lock:purge', ttlMs: 500 } });
    s.start();
    expect(named('scheduler_interval_seconds')).toEqual([{ name: 'scheduler_interval_seconds', labels: { key: 'lock:purge' }, value: 21600 }]);
    expect(named('scheduler_started_timestamp_seconds')).toEqual([{ name: 'scheduler_started_timestamp_seconds', labels: { key: 'lock:purge' }, value: 1_700_000_000 }]);
    s.stop();
  });

  it('an unlocked scheduler is keyed by its name, and stamps each successful cycle', async () => {
    const s = createScheduler({ name: 'digest', intervalMs: 1000, run: async () => {} });
    s.start();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1000);
    const stamps = named('scheduler_last_success_timestamp_seconds');
    expect(stamps.map((g) => g.labels)).toEqual([{ key: 'digest' }, { key: 'digest' }]);
    expect(stamps[1]!.value).toBeGreaterThan(stamps[0]!.value);
    s.stop();
  });

  it('a throwing cycle is not a success', async () => {
    const s = createScheduler({ name: 'boom', intervalMs: 1000, run: async () => { throw new Error('boom'); } });
    s.start();
    await jest.advanceTimersByTimeAsync(1000);
    expect(named('scheduler_last_success_timestamp_seconds')).toEqual([]);
    s.stop();
  });

  it('a pod that loses the lock race does not stamp — only the holder does', async () => {
    const contended = { set: jest.fn(async (..._a: unknown[]) => null), get: jest.fn(async () => null), del: jest.fn(async () => 1) };
    const run = jest.fn<() => Promise<void>>(async () => {});
    const s = createScheduler({ name: 'job', intervalMs: 1000, run, lock: { redis: () => contended, key: 'k', ttlMs: 500 } });
    s.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    expect(named('scheduler_last_success_timestamp_seconds')).toEqual([]);
    s.stop();
  });

  it('the lock holder stamps after its run returns', async () => {
    const held = { set: jest.fn(async (..._a: unknown[]) => 'OK'), get: jest.fn(async () => null), del: jest.fn(async () => 1) };
    const s = createScheduler({ name: 'job', intervalMs: 1000, run: async () => {}, lock: { redis: () => held, key: 'k', ttlMs: 500 } });
    s.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(named('scheduler_last_success_timestamp_seconds').map((g) => g.labels)).toEqual([{ key: 'k' }]);
    s.stop();
  });

  it('a cycle cut short by stop() is not stamped', async () => {
    let release!: () => void;
    const s = createScheduler({ name: 'slow', intervalMs: 10_000, run: () => new Promise<void>((r) => { release = r; }) });
    s.start();
    s.stop();
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(named('scheduler_last_success_timestamp_seconds')).toEqual([]);
  });
});
