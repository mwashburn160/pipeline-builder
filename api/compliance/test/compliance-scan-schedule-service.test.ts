// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { PgDialect } from 'drizzle-orm/pg-core';

let selectResults: unknown[][] = [];
let returningResults: unknown[][] = [];

function shift(q: unknown[][]): unknown[] {
  return q.length ? (q.shift() as unknown[]) : [];
}

function makeChain(terminal: () => Promise<unknown[]>): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'where', 'set', 'orderBy', 'limit', 'offset', 'values']) {
    chain[name] = jest.fn(() => chain);
  }
  chain.returning = jest.fn(() => Promise.resolve(shift(returningResults)));
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => terminal().then(resolve);
  return chain;
}

const tx = {
  select: jest.fn(() => makeChain(() => Promise.resolve(shift(selectResults)))),
  insert: jest.fn(() => makeChain(() => Promise.resolve(shift(returningResults)))),
  update: jest.fn(() => makeChain(() => Promise.resolve(shift(returningResults)))),
  delete: jest.fn(() => makeChain(() => Promise.resolve([]))),
};

type Where = Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0];

/** The rendered WHERE of the `index`-th call of `op` (select/update/delete). */
function whereOf(op: 'select' | 'update' | 'delete', index = 0): string {
  const chain = tx[op].mock.results[index].value as { where: jest.Mock };
  return new PgDialect().sqlToQuery(chain.where.mock.calls[0][0] as Where).sql;
}

function setOf(index = 0): Record<string, unknown> {
  return (tx.update.mock.results[index].value as { set: jest.Mock }).set.mock.calls[0][0] as Record<string, unknown>;
}

const NEXT_RUN = new Date('2026-08-01T06:00:00.000Z');
const calculateNextRun = jest.fn((..._args: unknown[]) => NEXT_RUN);

jest.unstable_mockModule('../src/helpers/scan-scheduler.js', () => ({
  calculateNextRun: (expr: string) => calculateNextRun(expr),
}));

// The REAL schema (the compiled table module, imported before the package is
// mocked), so the WHERE clauses below render to the SQL the database would run.
const { schema } = await import('@pipeline-builder/pipeline-data/lib/database/drizzle-schema.js');
const RETENTION_MS = 30 * 24 * 3600_000;
let retentionMs = RETENTION_MS;

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema,
  softDeleteRetentionMs: () => retentionMs,
  withTenantTx: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  drizzleCount: (r: unknown) => r,
}));

const { complianceScanScheduleService } = await import('../src/services/compliance-scan-schedule-service.js');

describe('ComplianceScanScheduleService', () => {
  beforeEach(() => {
    selectResults = [];
    returningResults = [];
    tx.select.mockClear();
    tx.insert.mockClear();
    tx.update.mockClear();
    tx.delete.mockClear();
    retentionMs = RETENTION_MS;
    calculateNextRun.mockClear();
  });

  describe('create', () => {
    it('computes nextRunAt from the cron expression and stores the schedule active', async () => {
      returningResults = [[{ id: 'sch-1', isActive: true }]];
      const schedule = await complianceScanScheduleService.create('org-1', 'u1', 'plugin', '0 6 * * *');
      expect(calculateNextRun).toHaveBeenCalledWith('0 6 * * *');
      const values = (tx.insert.mock.results[0].value as { values: jest.Mock }).values;
      const inserted = values.mock.calls[0][0] as Record<string, unknown>;
      expect(inserted.nextRunAt).toBe(NEXT_RUN);
      expect(inserted.isActive).toBe(true);
      expect(inserted.orgId).toBe('org-1');
      expect(schedule).toMatchObject({ id: 'sch-1' });
    });
  });

  describe('update', () => {
    it('recomputes nextRunAt only when the cron expression is in the patch', async () => {
      returningResults = [[{ id: 'sch-1' }]];
      await complianceScanScheduleService.update('sch-1', 'org-1', 'u1', { cronExpression: '*/15 * * * *' });
      expect(calculateNextRun).toHaveBeenCalledWith('*/15 * * * *');
      const setArg = (tx.update.mock.results[0].value as { set: jest.Mock }).set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.nextRunAt).toBe(NEXT_RUN);
    });

    it('does not touch nextRunAt when only the target changes', async () => {
      returningResults = [[{ id: 'sch-1' }]];
      await complianceScanScheduleService.update('sch-1', 'org-1', 'u1', { target: 'pipeline' });
      expect(calculateNextRun).not.toHaveBeenCalled();
      const setArg = (tx.update.mock.results[0].value as { set: jest.Mock }).set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.nextRunAt).toBeUndefined();
    });

    it('returns null when no row matches the id+org (cross-tenant / missing)', async () => {
      returningResults = [[]];
      const updated = await complianceScanScheduleService.update('sch-1', 'other-org', 'u1', { target: 'all' });
      expect(updated).toBeNull();
    });
  });

  describe('toggleActive', () => {
    it('recomputes nextRunAt from the stored cron when re-activating', async () => {
      selectResults = [[{ cronExpression: '0 0 * * *' }]]; // existing lookup
      returningResults = [[{ id: 'sch-1', isActive: true }]]; // update result
      await complianceScanScheduleService.toggleActive('sch-1', 'org-1', 'u1', true);
      expect(calculateNextRun).toHaveBeenCalledWith('0 0 * * *');
      const setArg = (tx.update.mock.results[0].value as { set: jest.Mock }).set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.nextRunAt).toBe(NEXT_RUN);
    });

    it('does not recompute nextRunAt when deactivating', async () => {
      returningResults = [[{ id: 'sch-1', isActive: false }]];
      await complianceScanScheduleService.toggleActive('sch-1', 'org-1', 'u1', false);
      expect(calculateNextRun).not.toHaveBeenCalled();
      expect(tx.select).not.toHaveBeenCalled();
    });

    it('skips the cron recompute when re-activating an id the org does not own', async () => {
      selectResults = [[]]; // existing lookup misses
      returningResults = [[]]; // update matches nothing
      const updated = await complianceScanScheduleService.toggleActive('sch-1', 'other-org', 'u1', true);
      expect(calculateNextRun).not.toHaveBeenCalled();
      expect(updated).toBeNull();
    });
  });

  /**
   * A deleted schedule is a tombstone: every read skips it and every write
   * matches nothing, so PUT /:id and PATCH /:id/active answer 404 instead of
   * reviving it.
   */
  describe('a soft-deleted schedule is invisible to every read and write', () => {
    const LIVE = '"compliance_scan_schedules"."deleted_at" is null';

    it('list skips tombstones (both the count and the page)', async () => {
      selectResults = [[{ count: 0 }], []];
      await complianceScanScheduleService.list('org-1', 10, 0);
      expect(whereOf('select', 0)).toContain(LIVE);
      expect(whereOf('select', 1)).toContain(LIVE);
    });

    it('findById skips tombstones', async () => {
      selectResults = [[]];
      expect(await complianceScanScheduleService.findById('sch-1', 'org-1')).toBeNull();
      expect(whereOf('select')).toContain(LIVE);
    });

    it('update matches only a live row, so a deleted one is not edited', async () => {
      returningResults = [[]];
      expect(await complianceScanScheduleService.update('sch-1', 'org-1', 'u1', { target: 'all' })).toBeNull();
      expect(whereOf('update')).toContain(LIVE);
    });

    it('re-activating a deleted schedule finds nothing — neither the cron lookup nor the update', async () => {
      selectResults = [[]];
      returningResults = [[]];
      expect(await complianceScanScheduleService.toggleActive('sch-1', 'org-1', 'u1', true)).toBeNull();
      expect(whereOf('select')).toContain(LIVE);
      expect(whereOf('update')).toContain(LIVE);
      expect(calculateNextRun).not.toHaveBeenCalled();
    });
  });

  describe('softDelete', () => {
    it('tombstones the schedule: deactivated, deletedAt/deletedBy + a purge deadline', async () => {
      returningResults = [[{ id: 'sch-1', isActive: false }]];
      const before = Date.now();
      const deleted = await complianceScanScheduleService.softDelete('sch-1', 'org-1', 'u1');
      const set = setOf();
      expect(set.isActive).toBe(false);
      expect(set.deletedBy).toBe('u1');
      expect(set.updatedBy).toBe('u1');
      expect((set.deletedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      // The shared SOFT_DELETE_RETENTION_DAYS window.
      expect((set.purgeAfter as Date).getTime() - (set.deletedAt as Date).getTime()).toBe(RETENTION_MS);
      expect(deleted).toMatchObject({ id: 'sch-1' });
    });

    it('stamps no purge deadline when retention is disabled (0 days) — the tombstone is kept', async () => {
      retentionMs = 0;
      returningResults = [[{ id: 'sch-1', isActive: false }]];
      await complianceScanScheduleService.softDelete('sch-1', 'org-1', 'u1');
      expect('purgeAfter' in setOf()).toBe(false);
      expect(setOf().deletedAt).toBeInstanceOf(Date);
    });

    it('matches only a live row, so deleting twice is a 404', async () => {
      returningResults = [[]];
      expect(await complianceScanScheduleService.softDelete('sch-1', 'org-1', 'u1')).toBeNull();
      expect(whereOf('update')).toContain('"compliance_scan_schedules"."deleted_at" is null');
    });

    it('returns null when the schedule is not found', async () => {
      returningResults = [[]];
      const deleted = await complianceScanScheduleService.softDelete('sch-1', 'other-org', 'u1');
      expect(deleted).toBeNull();
    });
  });

  describe('purgeExpired', () => {
    it('hard-deletes only tombstones past their purge deadline', async () => {
      selectResults = [[{ id: 'sch-1' }, { id: 'sch-2' }]];
      const now = new Date('2026-09-01T00:00:00.000Z');
      expect(await complianceScanScheduleService.purgeExpired(now, 50)).toBe(2);
      const where = whereOf('select');
      expect(where).toContain('"compliance_scan_schedules"."deleted_at" is not null');
      expect(where).toContain('"compliance_scan_schedules"."purge_after" <');
      const limit = (tx.select.mock.results[0].value as { limit: jest.Mock }).limit;
      expect(limit).toHaveBeenCalledWith(50);
      expect(whereOf('delete')).toContain('"compliance_scan_schedules"."id" in');
    });

    it('deletes nothing when no tombstone is due', async () => {
      selectResults = [[]];
      expect(await complianceScanScheduleService.purgeExpired(new Date())).toBe(0);
      expect(tx.delete).not.toHaveBeenCalled();
    });
  });
});
