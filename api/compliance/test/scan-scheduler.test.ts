// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

// createScheduler is exercised in api-core's own tests; here stub it to a
// no-op start/stop so the lifecycle wrappers are safe + idempotent to call.
// The sweep the scheduler would run each tick — captured so a test can drive it.
let sweep: (() => Promise<void>) | undefined;
const callOrder: string[] = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: (opts: { run: () => Promise<void> }) => { sweep = opts.run; return { start: jest.fn(), stop: jest.fn() }; },
}));

// Provide minimal Config + db + schema so the module loads.
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: {
    getAny: () => ({ scanSchedulerIntervalMs: 60000 }),
  },
}));
// The REAL schema (compiled table module, imported before the package is
// mocked), so the due-schedule WHERE renders to the SQL the database would run.
const { schema } = await import('@pipeline-builder/pipeline-data/lib/database/drizzle-schema.js');
/** Every WHERE the sweep's tenant-tx selects were given, in order. */
const selectWheres: unknown[] = [];
/** Every ORDER BY the sweep's selects were given, with the WHERE it ordered. */
const selectOrders: Array<{ where: unknown; order: unknown }> = [];

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema,
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
      from: jest.fn(() => ({
        where: jest.fn((w: unknown) => {
          selectWheres.push(w);
          const limit = jest.fn(() => Promise.resolve([]));
          return { limit, orderBy: jest.fn((o: unknown) => { selectOrders.push({ where: w, order: o }); return { limit }; }) };
        }),
      })),
    })),
    insert: jest.fn(() => ({ values: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) })),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) })) })),
  }),
}));;

jest.unstable_mockModule('../src/helpers/scan-executor.js', () => ({
  executeScan: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
  recoverStaleScans: jest.fn(async () => { callOrder.push('recoverStaleScans'); return 0; }),
}));

const { calculateNextRun, startScanScheduler, stopScanScheduler } = await import('../src/helpers/scan-scheduler.js');

// The grammar itself is api-core's (cron.test.ts); this covers the scheduler's
// contract: UTC, strictly after `from`, and the +1h fallback.
describe('calculateNextRun', () => {
  const FROM = new Date(Date.UTC(2026, 8, 16, 10, 7, 30)); // Wed 10:07:30Z
  const utcParts = (d: Date) => [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];

  it.each(['not a cron', '* * *', '0 0 31 2 *'])('falls back to 1 hour for %s', (expr) => {
    expect(calculateNextRun(expr, FROM).getTime() - FROM.getTime()).toBe(3600_000);
  });

  it('reads the expression in UTC, whatever the host timezone', () => {
    expect(utcParts(calculateNextRun('30 14 * * *', FROM))).toEqual([2026, 9, 16, 14, 30]);
    expect(utcParts(calculateNextRun('0 6 * * 1', FROM))).toEqual([2026, 9, 21, 6, 0]);
    expect(utcParts(calculateNextRun('0 0 20 * 5', FROM))).toEqual([2026, 9, 18, 0, 0]);
  });

  it('never returns `from` itself (strictly after)', () => {
    const exact = new Date(Date.UTC(2026, 8, 16, 10, 15));
    expect(utcParts(calculateNextRun('15 10 * * *', exact))).toEqual([2026, 9, 17, 10, 15]);
  });

  it('defaults `from` to now', () => {
    expect(calculateNextRun('* * * * *').getTime()).toBeGreaterThan(Date.now());
  });
});

describe('scheduler sweep', () => {
  it('recovers stale running scans at the start of every sweep', async () => {
    callOrder.length = 0;
    expect(sweep).toBeDefined();
    await sweep!();
    expect(callOrder).toEqual(['recoverStaleScans']);
  });

  /** A soft-deleted schedule must never fire, even while its row still exists. */
  it('only picks up live (not soft-deleted) schedules', async () => {
    selectWheres.length = 0;
    await sweep!();
    type Where = Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0];
    const due = selectWheres
      .map((w) => new PgDialect().sqlToQuery(w as Where).sql)
      .filter((q) => q.includes('"compliance_scan_schedules"'));
    expect(due).toHaveLength(1);
    const rendered = due[0];
    expect(rendered).toContain('"compliance_scan_schedules"."is_active" = $');
    expect(rendered).toContain('"compliance_scan_schedules"."deleted_at" is null');
  });
  // Pending scans are claimed 10 per tick. Without an ORDER BY the batch is
  // whatever order Postgres returns, so a steady inflow of new scans can starve
  // an older one indefinitely; oldest-first makes the queue FIFO.
  it('claims pending scans oldest first', async () => {
    selectOrders.length = 0;
    selectWheres.length = 0;
    await sweep!();
    type Where = Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0];
    const dialect = new PgDialect();
    const pending = selectWheres.find((w) => dialect.sqlToQuery(w as Where).sql.includes('"compliance_scans"."status"'));
    expect(pending).toBeDefined();
    const ordered = selectOrders.find((o) => o.where === pending);
    expect(ordered).toBeDefined();
    expect(dialect.sqlToQuery(ordered!.order as Where).sql).toBe('"compliance_scans"."created_at" asc');
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

