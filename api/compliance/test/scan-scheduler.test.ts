// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// createScheduler is exercised in api-core's own tests; here stub it to a
// no-op start/stop so the lifecycle wrappers are safe + idempotent to call.
// `createEnvRedisLock` returns null (no Redis in tests) so the scheduler is built
// lock-free; `createScheduler` is stubbed to a no-op start/stop so the lifecycle
// wrappers are safe + idempotent to call.
// The sweep the scheduler would run each tick — captured so a test can drive it.
let sweep: (() => Promise<void>) | undefined;
const callOrder: string[] = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: (opts: { run: () => Promise<void> }) => { sweep = opts.run; return { start: jest.fn(), stop: jest.fn() }; },
  createEnvRedisLock: () => null,
}));

// Provide minimal Config + db + schema so the module loads.
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: {
    getAny: () => ({ scanSchedulerIntervalMs: 60000 }),
  },
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: {
    complianceScan: {},
    complianceScanSchedule: {},
  },
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([])) })) })),
    })),
    insert: jest.fn(() => ({ values: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) })),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) })) })),
  },
  // scan-scheduler funnels every DB op through withTenantTx /
  // runWithTenantContext after the RLS migration — pass through to a tx with
  // the same chain shape the module expects.
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    select: jest.fn(() => ({
      from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([])) })) })),
    })),
    insert: jest.fn(() => ({ values: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) })),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) })) })),
  }),
}));;

jest.unstable_mockModule('../src/helpers/scan-executor.js', () => ({
  executeScan: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
  recoverStaleScans: jest.fn(async () => { callOrder.push('recoverStaleScans'); return 0; }),
}));

const { calculateNextRun, isValidCronExpression, startScanScheduler, stopScanScheduler } = await import('../src/helpers/scan-scheduler.js');

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

describe('scheduler sweep', () => {
  it('recovers stale running scans at the start of every sweep', async () => {
    callOrder.length = 0;
    expect(sweep).toBeDefined();
    await sweep!();
    expect(callOrder).toEqual(['recoverStaleScans']);
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

// isValidCronExpression — guards POST /scan-schedules against accepting
// malformed cron that would silently store nextRunAt=null and never fire.

describe('isValidCronExpression', () => {
  it('accepts standard 5-field cron', () => {
    expect(isValidCronExpression('0 0 * * *')).toBe(true);
    expect(isValidCronExpression('30 14 * * *')).toBe(true);
    expect(isValidCronExpression('* * * * *')).toBe(true);
  });

  it('accepts step expressions in minute/hour fields', () => {
    expect(isValidCronExpression('*/15 * * * *')).toBe(true);
    expect(isValidCronExpression('0 */6 * * *')).toBe(true);
  });

  it('rejects fewer than 5 fields', () => {
    expect(isValidCronExpression('* * * *')).toBe(false);
    expect(isValidCronExpression('0 0')).toBe(false);
  });

  it('rejects more than 5 fields', () => {
    expect(isValidCronExpression('0 0 * * * *')).toBe(false);
  });

  it('rejects empty / whitespace-only', () => {
    expect(isValidCronExpression('')).toBe(false);
    expect(isValidCronExpression('   ')).toBe(false);
  });

  it('rejects garbage that resembles cron', () => {
    expect(isValidCronExpression('hello world this is bad')).toBe(false);
    expect(isValidCronExpression('not a cron expression')).toBe(false);
  });

  it('rejects out-of-range minute or hour literals', () => {
    expect(isValidCronExpression('60 0 * * *')).toBe(false); // minute 60 invalid
    expect(isValidCronExpression('0 24 * * *')).toBe(false); // hour 24 invalid
  });
});

// Every field is honored (not just minute/hour), with the same grammar the
// validator accepts — steps, ranges and lists included.
describe('calculateNextRun — full 5-field grammar', () => {
  // Wed 2026-09-16 10:07 local.
  const FROM = new Date(2026, 8, 16, 10, 7, 30);
  const at = (expr: string) => calculateNextRun(expr, FROM);
  const parts = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];

  it('*/15 minute step → next quarter hour', () => {
    expect(parts(at('*/15 * * * *'))).toEqual([2026, 9, 16, 10, 15]);
  });

  it('*/6 HOUR step (previously ignored) → next 6-hour boundary', () => {
    expect(parts(at('0 */6 * * *'))).toEqual([2026, 9, 16, 12, 0]);
  });

  it('ranges and lists in minute/hour', () => {
    expect(parts(at('5,45 9-11 * * *'))).toEqual([2026, 9, 16, 10, 45]);
    expect(parts(at('0 8-9 * * *'))).toEqual([2026, 9, 17, 8, 0]);
  });

  it('day-of-week (previously ignored): Monday 06:00 → next Monday', () => {
    expect(parts(at('0 6 * * 1'))).toEqual([2026, 9, 21, 6, 0]);
    expect(parts(at('0 6 * * 7'))).toEqual([2026, 9, 20, 6, 0]); // 7 = Sunday
  });

  it('day-of-month + month', () => {
    expect(parts(at('0 0 1 * *'))).toEqual([2026, 10, 1, 0, 0]);
    expect(parts(at('30 2 15 1 *'))).toEqual([2027, 1, 15, 2, 30]);
  });

  it('dom AND dow both restricted → either matches (standard cron OR)', () => {
    // 20th OR any Friday → Fri 2026-09-18 comes first.
    expect(parts(at('0 0 20 * 5'))).toEqual([2026, 9, 18, 0, 0]);
  });

  it('a-b/n step inside a range', () => {
    expect(parts(at('0 1-23/10 * * *'))).toEqual([2026, 9, 16, 11, 0]);
  });

  it('never returns `from` itself (strictly after)', () => {
    const exact = new Date(2026, 8, 16, 10, 15, 0);
    expect(parts(calculateNextRun('15 10 * * *', exact))).toEqual([2026, 9, 17, 10, 15]);
  });
});

describe('isValidCronExpression — consistent with calculateNextRun', () => {
  it('accepts every field form the calculator honors', () => {
    for (const expr of ['0 6 * * 1', '0 0 1 * *', '*/5 9-17 * * 1-5', '0 0 1,15 * *', '0 */2 * 1-6 *', '0 0 * * 0,6']) {
      expect(isValidCronExpression(expr)).toBe(true);
    }
  });

  it('rejects malformed fields and impossible dates', () => {
    for (const expr of ['*/0 * * * *', '0 0 32 * *', '0 0 * 13 *', '0 0 * * 8', '5-1 * * * *', '1/ * * * *', '0 0 31 2 *', '-1 * * * *']) {
      expect(isValidCronExpression(expr)).toBe(false);
    }
  });
});
