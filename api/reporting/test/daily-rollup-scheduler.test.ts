// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the daily-rollup scheduler wiring (src/services/daily-rollup-scheduler.ts).
 * Regression: nothing ever called `runRollupPass`, so `execution_daily_rollups`
 * — which every analytics section reads — was never populated.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

type SchedulerOpts = { name: string; intervalMs: number; startupDelayMs: number; run: () => Promise<void>; lock: { key: string } };
const start = jest.fn<AnyFn>();
const stop = jest.fn<AnyFn>();
const createSchedulerSpy = jest.fn((_opts: SchedulerOpts) => ({ start, stop }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: createSchedulerSpy,
}));

const runRollupPass = jest.fn<(now?: Date) => Promise<{ days: number; rows: number }>>().mockResolvedValue({ days: 7, rows: 42 });
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  runRollupPass: (now?: Date) => runRollupPass(now),
}));

const { createDailyRollupScheduler, isDailyRollupEnabled, startDailyRollup, stopDailyRollup } =
  await import('../src/services/daily-rollup-scheduler.js');

const KEYS = ['REPORTING_ROLLUP_ENABLED', 'REPORTING_ROLLUP_INTERVAL_MINUTES'] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  jest.clearAllMocks();
  runRollupPass.mockResolvedValue({ days: 7, rows: 42 });
});
afterEach(() => {
  stopDailyRollup();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('daily rollup scheduler', () => {
  it('is enabled by default and honors the kill-switch', () => {
    expect(isDailyRollupEnabled()).toBe(true);
    process.env.REPORTING_ROLLUP_ENABLED = 'false';
    expect(isDailyRollupEnabled()).toBe(false);
    expect(createDailyRollupScheduler()).toBeNull();
    expect(createSchedulerSpy).not.toHaveBeenCalled();
  });

  it('builds a leader-locked hourly scheduler whose tick runs the rollup pass', async () => {
    expect(createDailyRollupScheduler()).not.toBeNull();
    const opts = createSchedulerSpy.mock.calls[0]![0];
    expect(opts.name).toBe('daily-rollup');
    expect(opts.intervalMs).toBe(60 * 60_000);
    expect(opts.lock.key).toContain('daily-rollup');
    await opts.run();
    expect(runRollupPass).toHaveBeenCalledTimes(1);
  });

  it('honors the interval override', () => {
    process.env.REPORTING_ROLLUP_INTERVAL_MINUTES = '15';
    createDailyRollupScheduler();
    expect(createSchedulerSpy.mock.calls[0]![0].intervalMs).toBe(15 * 60_000);
  });

  it('a failing pass never escapes the tick', async () => {
    createDailyRollupScheduler();
    runRollupPass.mockRejectedValueOnce(new Error('db down'));
    await expect(createSchedulerSpy.mock.calls[0]![0].run()).resolves.toBeUndefined();
  });

  it('start is idempotent and stop stops it', () => {
    startDailyRollup();
    startDailyRollup();
    expect(createSchedulerSpy).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    stopDailyRollup();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
