// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the compliance audit log retention helper + cron.
 *
 * Verifies:
 * - Single-shot prune issues the right DELETE with a cutoff date.
 * - Returns the number of deleted rows.
 * - Rejects nonsense maxAgeDays (zero, negative, NaN).
 * - The cron is a leader-locked scheduler with the configured delay/interval.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const dbDelete = jest.fn<(...args: unknown[]) => Promise<unknown>>();
/** Which table each DELETE targeted, and its WHERE, in call order. */
const deletes: Array<{ table: unknown; where: unknown }> = [];
const ltMock = jest.fn((col: unknown, val: unknown) => ({ __op: 'lt', col, val }));

type SchedOpts = { name: string; intervalMs: number; startupDelayMs?: number; lock?: { key: string; ttlMs: number }; run: () => Promise<void> };
let schedOpts: SchedOpts | undefined;
const schedStart = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: (o: SchedOpts) => { schedOpts = o; return { start: schedStart, stop: jest.fn() }; },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: {
    complianceAuditLog: { __t: 'audit', id: 'col_id', createdAt: 'col_created_at' },
    complianceScan: { __t: 'scan', id: 'scan_id', createdAt: 'scan_created_at', status: 'scan_status' },
    complianceNotificationLog: { __t: 'notif', id: 'notif_id', createdAt: 'notif_created_at', status: 'notif_status' },
  },
  // pruneComplianceAudit wraps the DELETE in runWithTenantContext +
  // withTenantTx; both pass through to the original callback in tests so
  // the dbDelete spy still observes a single call per prune invocation.
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    delete: (table: unknown) => ({
      where: (where: unknown) => {
        deletes.push({ table, where });
        return { returning: () => dbDelete() };
      },
    }),
    insert: jest.fn(),
  }),
}));

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  lt: (col: unknown, val: unknown) => ltMock(col, val),
  and: (...a: unknown[]) => ({ __op: 'and', a }),
  inArray: (col: unknown, vals: unknown[]) => ({ __op: 'inArray', col, vals }),
  ne: (col: unknown, val: unknown) => ({ __op: 'ne', col, val }),
}));

const {
  pruneComplianceAudit,
  pruneFinishedScans,
  pruneNotificationLog,
  startAuditPruneCron,
  DEFAULT_AUDIT_RETENTION_DAYS,
} = await import('../src/helpers/compliance-check-log.js');

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
  beforeEach(() => { dbDelete.mockReset(); schedStart.mockClear(); schedOpts = undefined; });

  it('starts a leader-locked scheduler with the first-run delay and interval', () => {
    startAuditPruneCron({ maxAgeDays: 30, intervalMs: 60_000, firstRunDelayMs: 1_000 });
    expect(schedStart).toHaveBeenCalledTimes(1);
    expect(schedOpts).toMatchObject({ intervalMs: 60_000, startupDelayMs: 1_000, lock: { key: 'compliance:audit-prune:leader' } });
  });

  it('each cycle prunes the audit log, finished scans and the notification log with the configured retention', async () => {
    dbDelete.mockResolvedValue([{ id: '1' }]);
    ltMock.mockClear();
    deletes.length = 0;
    const before = Date.now();
    startAuditPruneCron({ maxAgeDays: 30 });
    await schedOpts!.run();
    expect(dbDelete).toHaveBeenCalledTimes(3);
    expect(deletes.map((d) => (d.table as { __t: string }).__t)).toEqual(['audit', 'scan', 'notif']);
    for (const call of ltMock.mock.calls) {
      const cutoff = call[1] as Date;
      expect(Math.abs(cutoff.getTime() - (before - 30 * 24 * 60 * 60 * 1000))).toBeLessThan(2_000);
    }
  });

  it('a failing prune THROWS out of the cycle (so the scheduler records no success)', async () => {
    dbDelete.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('db down'));
    startAuditPruneCron({ maxAgeDays: 30 });
    await expect(schedOpts!.run()).rejects.toThrow('db down');
  });
});

describe('pruneFinishedScans', () => {
  beforeEach(() => { dbDelete.mockReset(); ltMock.mockClear(); deletes.length = 0; });

  it('deletes only FINISHED scans past the window (a stuck pending/running row survives)', async () => {
    dbDelete.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    await expect(pruneFinishedScans(90)).resolves.toBe(2);
    const where = deletes[0].where as { __op: string; a: Array<{ __op: string; col: unknown; vals?: unknown[] }> };
    expect(where.__op).toBe('and');
    expect(where.a[0]).toMatchObject({ __op: 'lt', col: 'scan_created_at' });
    expect(where.a[1]).toEqual({ __op: 'inArray', col: 'scan_status', vals: ['completed', 'failed', 'cancelled'] });
  });

  it('rejects a nonsense window', async () => {
    await expect(pruneFinishedScans(0)).rejects.toThrow(/maxAgeDays/);
  });
});

describe('pruneNotificationLog', () => {
  beforeEach(() => { dbDelete.mockReset(); ltMock.mockClear(); deletes.length = 0; });

  it('deletes notification-log rows older than the window, never a parked (pending) digest row', async () => {
    dbDelete.mockResolvedValue([{ id: 'n1' }]);
    const before = Date.now();
    await expect(pruneNotificationLog(10)).resolves.toBe(1);
    const where = deletes[0].where as { a: unknown[] };
    expect(where.a[1]).toEqual({ __op: 'ne', col: 'notif_status', val: 'pending' });
    expect(ltMock.mock.calls[0]?.[0]).toBe('notif_created_at');
    const cutoff = ltMock.mock.calls[0]?.[1] as Date;
    expect(Math.abs(cutoff.getTime() - (before - 10 * 24 * 60 * 60 * 1000))).toBeLessThan(2_000);
  });

  it('rejects a nonsense window', async () => {
    await expect(pruneNotificationLog(-1)).rejects.toThrow(/maxAgeDays/);
  });
});
