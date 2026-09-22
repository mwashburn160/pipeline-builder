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
const ltMock = jest.fn((col: unknown, val: unknown) => ({ __op: 'lt', col, val }));

type SchedOpts = { name: string; intervalMs: number; startupDelayMs?: number; lock?: { key: string; ttlMs: number }; run: () => Promise<void> };
let schedOpts: SchedOpts | undefined;
const schedStart = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: (o: SchedOpts) => { schedOpts = o; return { start: schedStart, stop: jest.fn() }; },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
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

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  lt: (col: unknown, val: unknown) => ltMock(col, val),
}));

const {
  pruneComplianceAudit,
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
    expect(schedOpts).toMatchObject({ intervalMs: 60_000, startupDelayMs: 1_000, lock: { key: 'compliance-audit-prune:leader' } });
  });

  it('each cycle prunes with the configured retention', async () => {
    dbDelete.mockResolvedValue([{ id: '1' }]);
    ltMock.mockClear();
    const before = Date.now();
    startAuditPruneCron({ maxAgeDays: 30 });
    await schedOpts!.run();
    expect(dbDelete).toHaveBeenCalledTimes(1);
    const cutoff = ltMock.mock.calls[0]?.[1] as Date;
    expect(Math.abs(cutoff.getTime() - (before - 30 * 24 * 60 * 60 * 1000))).toBeLessThan(2_000);
  });
});
