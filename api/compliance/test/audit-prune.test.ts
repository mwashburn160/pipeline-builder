// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the compliance audit log retention helper + cron.
 *
 * Verifies:
 * - Single-shot prune issues the right DELETE with a cutoff date.
 * - Returns the number of deleted rows.
 * - Rejects nonsense maxAgeDays (zero, negative, NaN).
 * - Cron schedules first run after firstRunDelayMs and reschedules itself.
 * - stop() prevents further executions.
 * - Tick failures don't kill the cron — next tick still scheduled.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const dbDelete = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const ltMock = jest.fn((col: unknown, val: unknown) => ({ __op: 'lt', col, val }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: {
    complianceAuditLog: { id: 'col_id', createdAt: 'col_created_at' },
  },
  // pruneComplianceAudit wraps the DELETE in runWithTenantContext +
  // withTenantTx; both pass through to the original callback in tests so
  // the dbDelete spy still observes a single call per prune invocation.
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    delete: () => ({
      where: () => ({
        returning: () => dbDelete(),
      }),
    }),
    insert: jest.fn(),
  }),
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  lt: (col: unknown, val: unknown) => ltMock(col, val),
}));

const {
  pruneComplianceAudit,
  startAuditPruneCron,
  DEFAULT_AUDIT_RETENTION_DAYS,
} = await import('../src/helpers/audit-logger.js');

describe('pruneComplianceAudit', () => {
  beforeEach(() => {
    dbDelete.mockReset();
    ltMock.mockClear();
  });

  it('uses the default retention when no arg passed', async () => {
    dbDelete.mockResolvedValue([{ id: '1' }, { id: '2' }, { id: '3' }]);
    const before = Date.now();
    const deleted = await pruneComplianceAudit();
    expect(deleted).toBe(3);
    expect(ltMock).toHaveBeenCalledTimes(1);
    const cutoff = ltMock.mock.calls[0]?.[1] as Date;
    const expectedMs = before - DEFAULT_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expectedMs)).toBeLessThan(2_000);
  });

  it('honors an explicit maxAgeDays override', async () => {
    dbDelete.mockResolvedValue([]);
    const before = Date.now();
    const deleted = await pruneComplianceAudit(7);
    expect(deleted).toBe(0);
    const cutoff = ltMock.mock.calls[0]?.[1] as Date;
    const expectedMs = before - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expectedMs)).toBeLessThan(2_000);
  });

  it('rejects zero, negative, and NaN maxAgeDays', async () => {
    await expect(pruneComplianceAudit(0)).rejects.toThrow(/maxAgeDays/);
    await expect(pruneComplianceAudit(-5)).rejects.toThrow(/maxAgeDays/);
    await expect(pruneComplianceAudit(NaN)).rejects.toThrow(/maxAgeDays/);
  });
});

describe('startAuditPruneCron', () => {
  beforeEach(() => {
    dbDelete.mockReset();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedules first run after firstRunDelayMs', async () => {
    dbDelete.mockResolvedValue([]);
    const handle = startAuditPruneCron({ maxAgeDays: 30, intervalMs: 60_000, firstRunDelayMs: 1_000 });
    expect(dbDelete).not.toHaveBeenCalled();
    jest.advanceTimersByTime(999);
    expect(dbDelete).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2);
    // Allow the awaited promise inside the timer callback to settle.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(dbDelete).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('reschedules after each tick', async () => {
    dbDelete.mockResolvedValue([]);
    const handle = startAuditPruneCron({ maxAgeDays: 30, intervalMs: 60_000, firstRunDelayMs: 100 });
    jest.advanceTimersByTime(101);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(dbDelete).toHaveBeenCalledTimes(1);

    // Next tick + max jitter (5 min). Advance past worst case.
    jest.advanceTimersByTime(60_000 + 5 * 60_000 + 1);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(dbDelete).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('stop() halts further runs', async () => {
    dbDelete.mockResolvedValue([]);
    const handle = startAuditPruneCron({ maxAgeDays: 30, intervalMs: 60_000, firstRunDelayMs: 100 });
    jest.advanceTimersByTime(101);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(dbDelete).toHaveBeenCalledTimes(1);

    handle.stop();
    jest.advanceTimersByTime(60 * 60 * 1000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(dbDelete).toHaveBeenCalledTimes(1);
  });

  it('failure in one tick does not stop the cron', async () => {
    dbDelete
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue([]);
    const handle = startAuditPruneCron({ maxAgeDays: 30, intervalMs: 60_000, firstRunDelayMs: 100 });
    jest.advanceTimersByTime(101);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(dbDelete).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000 + 5 * 60_000 + 1);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(dbDelete).toHaveBeenCalledTimes(2);
    handle.stop();
  });
});
