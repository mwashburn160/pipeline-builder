// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

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
};

const NEXT_RUN = new Date('2026-08-01T06:00:00.000Z');
const calculateNextRun = jest.fn(() => NEXT_RUN);

jest.unstable_mockModule('../src/helpers/scan-scheduler.js', () => ({
  calculateNextRun: (expr: string) => calculateNextRun(expr),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: {
    complianceScanSchedule: {
      id: 'col_id',
      orgId: 'col_org',
      createdAt: 'col_created',
      cronExpression: 'col_cron',
      isActive: 'col_active',
      nextRunAt: 'col_next',
      target: 'col_target',
      createdBy: 'col_cby',
      updatedBy: 'col_uby',
      updatedAt: 'col_uat',
    },
  },
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

  describe('softDelete', () => {
    it('marks the schedule inactive and returns it', async () => {
      returningResults = [[{ id: 'sch-1', isActive: false }]];
      const deleted = await complianceScanScheduleService.softDelete('sch-1', 'org-1');
      const setArg = (tx.update.mock.results[0].value as { set: jest.Mock }).set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.isActive).toBe(false);
      expect(deleted).toMatchObject({ id: 'sch-1' });
    });

    it('returns null when the schedule is not found', async () => {
      returningResults = [[]];
      const deleted = await complianceScanScheduleService.softDelete('sch-1', 'other-org');
      expect(deleted).toBeNull();
    });
  });
});
