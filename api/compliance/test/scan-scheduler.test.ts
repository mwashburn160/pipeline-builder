// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// Provide minimal Config + db + schema so the module loads.
jest.mock('@pipeline-builder/pipeline-core', () => ({
  Config: {
    getAny: () => ({ scanSchedulerIntervalMs: 60000 }),
  },
  schema: {
    complianceScan: {},
    complianceScanSchedule: {},
  },
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([])) })) })),
    })),
    insert: jest.fn(() => ({ values: jest.fn().mockResolvedValue(undefined) })),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })) })),
  },
}));

jest.mock('../src/helpers/scan-executor', () => ({
  executeScan: jest.fn().mockResolvedValue(undefined),
}));

import { calculateNextRun, startScanScheduler, stopScanScheduler } from '../src/helpers/scan-scheduler';

describe('calculateNextRun', () => {
  it('falls back to ~1 hour for invalid cron', () => {
    const before = Date.now();
    const next = calculateNextRun('not a cron');
    const diff = next.getTime() - before;
    expect(diff).toBeGreaterThan(3500_000);
    expect(diff).toBeLessThan(3700_000);
  });

  it('falls back to ~1 hour when wrong number of fields', () => {
    const before = Date.now();
    const next = calculateNextRun('* * *');
    const diff = next.getTime() - before;
    expect(diff).toBeGreaterThan(3500_000);
    expect(diff).toBeLessThan(3700_000);
  });

  it('parses "0 0 * * *" as next midnight', () => {
    const next = calculateNextRun('0 0 * * *');
    expect(next.getMinutes()).toBe(0);
    expect(next.getHours()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it('parses "30 14 * * *" as next 14:30', () => {
    const next = calculateNextRun('30 14 * * *');
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours()).toBe(14);
  });

  it('parses "*/15 * * * *" as the next 15-minute interval', () => {
    const next = calculateNextRun('*/15 * * * *');
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getMinutes() % 15).toBe(0);
  });

  it('parses "0 * * * *" as the next top-of-hour', () => {
    const next = calculateNextRun('0 * * * *');
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns a Date object', () => {
    expect(calculateNextRun('0 0 * * *')).toBeInstanceOf(Date);
  });
});

describe('scheduler lifecycle', () => {
  afterEach(() => {
    stopScanScheduler();
  });

  it('startScanScheduler is idempotent', () => {
    expect(() => {
      startScanScheduler();
      startScanScheduler();
    }).not.toThrow();
  });

  it('stopScanScheduler is safe to call without start', () => {
    expect(() => stopScanScheduler()).not.toThrow();
  });
});
