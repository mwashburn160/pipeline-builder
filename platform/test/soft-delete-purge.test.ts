// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/soft-delete-purge.ts — the platform retention sweep for its
 * hand-rolled soft-delete tables (dashboards, alert destinations, alert rules).
 * Each entity hard-deletes ONLY expired tombstones (deleted AND past
 * purge_after), bounded by the batch limit, inside the tenant transaction the
 * shared scheduler scopes; nothing expired → no DELETE at all. The scheduler is
 * started once and stops cleanly.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { drizzleMock, stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...parts: unknown[]) => ({ and: parts }),
  inArray: (col: unknown, ids: unknown[]) => ({ inArray: [col, ids] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));

const table = (name: string) => ({ name, id: `${name}.id`, deletedAt: `${name}.deleted_at`, purgeAfter: `${name}.purge_after` });
const schema = { dashboard: table('dashboard'), orgAlertDestination: table('org_alert_destination'), orgAlertRule: table('org_alert_rule') };

/** A drizzle-shaped fake transaction: select → from → where → limit → then; delete → where. */
let doomedIds: string[] = [];
const ops: Array<{ op: string; table?: unknown; where?: unknown; limit?: number }> = [];
const tx = {
  select: () => ({
    from: (t: unknown) => ({
      where: (w: unknown) => ({
        limit: (n: number) => {
          ops.push({ op: 'select', table: t, where: w, limit: n });
          return { then: (f: (rows: Array<{ id: string }>) => unknown) => Promise.resolve(f(doomedIds.map((id) => ({ id })))) };
        },
      }),
    }),
  }),
  delete: (t: unknown) => ({ where: async (w: unknown) => { ops.push({ op: 'delete', table: t, where: w }); } }),
};
const withTenantTx = jest.fn<AnyFn>(async (fn: (t: typeof tx) => unknown) => fn(tx));

let schedulerArgs: { service: string; entities: Array<{ name: string; purgeExpired: (now: Date, limit?: number) => Promise<number> }> } | undefined;
const sched = { start: jest.fn<AnyFn>(), stop: jest.fn<AnyFn>() };
let enabled = true;
const createSoftDeletePurgeScheduler = jest.fn<AnyFn>((args: typeof schedulerArgs) => { schedulerArgs = args; return enabled ? sched : null; });

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema, withTenantTx, createSoftDeletePurgeScheduler,
}));

const { softDeletePurgeSweep } = await import('../src/services/soft-delete-purge.js');

/** What the sweep registry does with the definition: build once, start, stop. */
let active: { start(): void; stop(): void } | null = null;
function startSoftDeletePurge(): void {
  if (active) return;
  active = softDeletePurgeSweep.create();
  active?.start();
}
function stopSoftDeletePurge(): void {
  active?.stop();
  active = null;
}

const NOW = new Date('2026-09-21T00:00:00Z');
const entity = (name: string) => schedulerArgs!.entities.find((e) => e.name === name)!;

beforeEach(() => {
  stopSoftDeletePurge();
  jest.clearAllMocks();
  ops.length = 0;
  doomedIds = [];
  enabled = true;
});

describe('scheduler wiring', () => {
  it('registers the three platform tables with the shared sweep and starts it once', () => {
    startSoftDeletePurge();
    startSoftDeletePurge();
    expect(createSoftDeletePurgeScheduler).toHaveBeenCalledTimes(1);
    expect(schedulerArgs!.service).toBe('platform');
    expect(schedulerArgs!.entities.map((e) => e.name)).toEqual(['dashboard', 'org_alert_destination', 'org_alert_rule']);
    expect(sched.start).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the sweep is disabled (no scheduler), and stops cleanly', () => {
    enabled = false;
    startSoftDeletePurge();
    expect(sched.start).not.toHaveBeenCalled();
    stopSoftDeletePurge();
    enabled = true;
    startSoftDeletePurge();
    stopSoftDeletePurge();
    expect(sched.stop).toHaveBeenCalledTimes(1);
  });
});

describe.each(['dashboard', 'org_alert_destination', 'org_alert_rule'])('%s purge', (name) => {
  beforeEach(() => startSoftDeletePurge());

  it('hard-deletes exactly the expired tombstones it selected, in the tenant transaction', async () => {
    doomedIds = ['a', 'b'];
    await expect(entity(name).purgeExpired(NOW, 25)).resolves.toBe(2);
    expect(withTenantTx).toHaveBeenCalledTimes(1);
    const [select, del] = ops;
    expect(select).toMatchObject({ op: 'select', limit: 25 });
    // Only tombstones: deleted AND past purge_after (bound to `now`).
    const where = select!.where as { and: Array<{ sql: string; values: unknown[] }> };
    expect(where.and[0]!.values).toEqual([`${name}.deleted_at`]);
    expect(where.and[1]!.values).toEqual([`${name}.purge_after`, NOW]);
    expect(del).toMatchObject({ op: 'delete', where: { inArray: [`${name}.id`, ['a', 'b']] } });
  });

  it('issues no DELETE when nothing has expired, and defaults the batch to 500', async () => {
    await expect(entity(name).purgeExpired(NOW)).resolves.toBe(0);
    expect(ops).toEqual([expect.objectContaining({ op: 'select', limit: 500 })]);
  });
});
