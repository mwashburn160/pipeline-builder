// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for services/dashboard-service.ts with the drizzle transaction
 * doubled: every query in a `withTenantTx` callback resolves to the next value
 * queued in `results`, and each chain step is recorded so a test can assert
 * what was written (insert values, update sets, the visibility filter).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Step = { op: string; args: unknown[] };

let results: unknown[] = [];
let queries: Step[][] = [];
let retentionMs = 0;

/** A drizzle-ish query builder: chainable, awaitable, one queued result per query. */
function txDouble(): any {
  const tx: any = {};
  for (const root of ['select', 'insert', 'update', 'delete']) {
    tx[root] = (...args: unknown[]) => {
      const steps: Step[] = [{ op: root, args }];
      queries.push(steps);
      const chain: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'then') {
            const value = results.shift();
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject);
          }
          return (...a: unknown[]) => { steps.push({ op: prop, args: a }); return chain; };
        },
      });
      return chain;
    };
  }
  return tx;
}

const withTenantTx = jest.fn(async (fn: (tx: any) => unknown) => fn(txDouble()));

const col = (table: string) => new Proxy({}, { get: (_t, c: string) => `${table}.${c}` });
const sqlTag = (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join('?'), vals });

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  db: { transaction: jest.fn() },
  schema: { dashboard: col('dashboard'), dashboardPanel: col('dashboardPanel') },
  withTenantTx: (fn: (tx: any) => unknown) => withTenantTx(fn),
  softDeleteRetentionMs: () => retentionMs,
}));
jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...a: unknown[]) => ({ and: a }),
  or: (...a: unknown[]) => ({ or: a }),
  eq: (c: unknown, v: unknown) => ({ eq: [c, v] }),
  inArray: (c: unknown, v: unknown) => ({ inArray: [c, v] }),
  isNull: (c: unknown) => ({ isNull: c }),
  asc: (c: unknown) => ({ asc: c }),
  desc: (c: unknown) => ({ desc: c }),
  sql: sqlTag,
}));

const { DashboardService, dashboardService } = await import('../src/services/dashboard-service.js');

const step = (q: Step[], op: string) => q.find((s) => s.op === op);

const dash = (over: Record<string, unknown> = {}): any => ({
  id: 'd-1',
  orgId: 'org-1',
  createdBy: 'u-1',
  name: 'Ops',
  description: null,
  visibility: 'org',
  layoutJson: {},
  ...over,
});

let svc: InstanceType<typeof DashboardService>;
beforeEach(() => {
  svc = new DashboardService();
  results = [];
  queries = [];
  retentionMs = 0;
  withTenantTx.mockClear();
});

describe('exports', () => {
  it('exports a shared instance', () => {
    expect(dashboardService).toBeInstanceOf(DashboardService);
  });
});

describe('list / listDeleted', () => {
  const caller = { orgId: 'org-1', userId: 'u-1', isSuperAdmin: false };

  it('a sysadmin lists every live dashboard without a visibility filter', async () => {
    results = [[dash()]];
    expect(await svc.list({ ...caller, isSuperAdmin: true })).toEqual([dash()]);
    expect(step(queries[0], 'where')!.args[0]).toEqual({ isNull: 'dashboard.deletedAt' });
    expect(step(queries[0], 'orderBy')!.args[0]).toEqual({ asc: 'dashboard.name' });
  });

  it('a caller lists through the visibility tree', async () => {
    results = [[]];
    await svc.list(caller);
    const where = step(queries[0], 'where')!.args[0] as any;
    expect(where.and[1].or).toHaveLength(3);
    expect(where.and[1].or[1]).toEqual({ and: [{ eq: ['dashboard.visibility', 'org'] }, { eq: ['dashboard.orgId', 'org-1'] }] });
  });

  it('a sysadmin lists every tombstone newest first', async () => {
    results = [[dash()]];
    await svc.listDeleted({ ...caller, isSuperAdmin: true });
    expect(step(queries[0], 'orderBy')!.args[0]).toEqual({ desc: 'dashboard.deletedAt' });
    expect((step(queries[0], 'where')!.args[0] as any).sql).toContain('IS NOT NULL');
  });

  it('a caller lists tombstones through the visibility tree', async () => {
    results = [[]];
    await svc.listDeleted(caller);
    const where = step(queries[0], 'where')!.args[0] as any;
    expect(where.and[1].or[2]).toEqual({ and: [{ eq: ['dashboard.visibility', 'private'] }, { eq: ['dashboard.createdBy', 'u-1'] }] });
  });
});

describe('findById / findDeletedById', () => {
  it('returns null when no live row matches', async () => {
    results = [[]];
    expect(await svc.findById('d-x')).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it('returns the row with its panels', async () => {
    results = [[dash()], [{ id: 'p-1' }]];
    expect(await svc.findById('d-1')).toEqual({ ...dash(), panels: [{ id: 'p-1' }] });
    expect(step(queries[1], 'orderBy')!.args[0]).toEqual({ asc: 'dashboardPanel.position' });
  });

  it('findDeletedById returns the tombstone or null', async () => {
    results = [[dash()]];
    expect(await svc.findDeletedById('d-1')).toEqual(dash());
    results = [[]];
    expect(await svc.findDeletedById('d-1')).toBeNull();
  });
});

describe('listPanelKeys', () => {
  it('short-circuits on no ids', async () => {
    expect((await svc.listPanelKeys([])).size).toBe(0);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('groups query keys by dashboard', async () => {
    results = [[
      { dashboardId: 'a', queryKey: 'k1' },
      { dashboardId: 'b', queryKey: 'k2' },
      { dashboardId: 'a', queryKey: 'k3' },
    ]];
    const out = await svc.listPanelKeys(['a', 'b', 'c']);
    expect(Object.fromEntries(out)).toEqual({ a: ['k1', 'k3'], b: ['k2'] });
  });
});

describe('canRead / canWrite', () => {
  const reader = { orgId: 'org-1', userId: 'u-2', isSuperAdmin: false };

  it.each([
    ['sysadmin sees private', dash({ visibility: 'private' }), { ...reader, isSuperAdmin: true }, true],
    ['public', dash({ visibility: 'public', orgId: 'other' }), reader, true],
    ['org same-org', dash(), reader, true],
    ['org other-org', dash({ orgId: 'other' }), reader, false],
    ['private not mine', dash({ visibility: 'private' }), reader, false],
    ['private mine', dash({ visibility: 'private', createdBy: 'u-2' }), reader, true],
  ])('canRead: %s', (_n, d, c, expected) => {
    expect(svc.canRead(d, c)).toBe(expected);
  });

  const writer = { ...reader, isOrgAdmin: false };
  it.each([
    ['sysadmin', dash({ visibility: 'public' }), { ...writer, isSuperAdmin: true }, true],
    ['public non-sysadmin', dash({ visibility: 'public', createdBy: 'u-2' }), writer, false],
    ['creator', dash({ visibility: 'private', createdBy: 'u-2' }), writer, true],
    ['org admin same org', dash(), { ...writer, isOrgAdmin: true }, true],
    ['org admin other org', dash({ orgId: 'other' }), { ...writer, isOrgAdmin: true }, false],
    ['org non-admin', dash(), writer, false],
  ])('canWrite: %s', (_n, d, c, expected) => {
    expect(svc.canWrite(d, c)).toBe(expected);
  });
});

describe('create', () => {
  const caller = { orgId: 'org-1', userId: 'u-1' };

  it('defaults visibility/description/layout and skips the panel insert when empty', async () => {
    results = [[dash({ visibility: 'private' })]];
    const out = await svc.create({ name: 'Ops', panels: [] }, caller);
    expect(out.panels).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(step(queries[0], 'values')!.args[0]).toEqual({
      orgId: 'org-1',
      createdBy: 'u-1',
      updatedBy: 'u-1',
      name: 'Ops',
      description: null,
      layoutJson: {},
      visibility: 'private',
    });
  });

  it('inserts panels with defaults and index positions', async () => {
    results = [[dash()], [{ id: 'p-1' }, { id: 'p-2' }]];
    const out = await svc.create({
      name: 'Ops',
      description: 'd',
      visibility: 'org',
      layoutJson: { a: { x: 0, y: 0, w: 1, h: 1 } },
      panels: [
        { queryKey: 'k1', title: 'one' },
        { queryKey: 'k2', title: 'two', vizKind: 'bar', span: 12, groupBy: 'g', format: 'pct', position: 9 },
      ],
    }, caller);
    expect(out.panels).toHaveLength(2);
    expect(step(queries[0], 'values')!.args[0]).toMatchObject({ description: 'd', visibility: 'org' });
    expect(step(queries[1], 'values')!.args[0]).toEqual([
      { dashboardId: 'd-1', queryKey: 'k1', vizKind: 'line', title: 'one', span: 6, groupBy: null, format: null, position: 0 },
      { dashboardId: 'd-1', queryKey: 'k2', vizKind: 'bar', title: 'two', span: 12, groupBy: 'g', format: 'pct', position: 9 },
    ]);
  });
});

describe('update', () => {
  it('returns null when no live row matched', async () => {
    results = [[]];
    expect(await svc.update('d-x', { name: 'n' }, { userId: 'u-1' })).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it('sets only supplied fields and re-reads panels when untouched', async () => {
    results = [[dash({ name: 'New' })], [{ id: 'p-1' }]];
    const out = await svc.update('d-1', { name: 'New', description: null, visibility: 'public', layoutJson: {} }, { userId: 'u-9' });
    expect(step(queries[0], 'set')!.args[0]).toEqual({ updatedBy: 'u-9', name: 'New', description: null, visibility: 'public', layoutJson: {} });
    expect(queries[1][0].op).toBe('select');
    expect(out).toEqual({ ...dash({ name: 'New' }), panels: [{ id: 'p-1' }] });
  });

  it('only stamps updatedBy when nothing else is supplied', async () => {
    results = [[dash()], []];
    await svc.update('d-1', {}, { userId: 'u-9' });
    expect(step(queries[0], 'set')!.args[0]).toEqual({ updatedBy: 'u-9' });
  });

  it('replaces the panel set when panels are supplied', async () => {
    results = [[dash()], undefined, [{ id: 'p-new' }]];
    const out = await svc.update('d-1', { panels: [{ queryKey: 'k', title: 't' }] }, { userId: 'u-1' });
    expect(queries.map((q) => q[0].op)).toEqual(['update', 'delete', 'insert']);
    expect(out!.panels).toEqual([{ id: 'p-new' }]);
  });
});

describe('delete / restore / purgeById', () => {
  it('soft-deletes without purgeAfter when retention is off', async () => {
    results = [[{ id: 'd-1' }]];
    expect(await svc.delete('d-1', { userId: 'u-1' })).toBe(true);
    const set = step(queries[0], 'set')!.args[0] as any;
    expect(set.deletedBy).toBe('u-1');
    expect(set.deletedAt).toBeInstanceOf(Date);
    expect(set).not.toHaveProperty('purgeAfter');
  });

  it('stamps purgeAfter when retention is on, and reports a miss', async () => {
    retentionMs = 1000;
    results = [[]];
    expect(await svc.delete('d-1', { userId: 'u-1' })).toBe(false);
    const set = step(queries[0], 'set')!.args[0] as any;
    expect(set.purgeAfter.getTime() - set.deletedAt.getTime()).toBe(1000);
  });

  it('restore clears the tombstone', async () => {
    results = [[{ id: 'd-1' }]];
    expect(await svc.restore('d-1', { userId: 'u-1' })).toBe(true);
    expect(step(queries[0], 'set')!.args[0]).toMatchObject({ deletedAt: null, deletedBy: null, updatedBy: 'u-1' });
    results = [[]];
    expect(await svc.restore('d-1', { userId: 'u-1' })).toBe(false);
  });

  it('purgeById hard-deletes a tombstone only', async () => {
    results = [[{ id: 'd-1' }]];
    expect(await svc.purgeById('d-1')).toBe(true);
    expect(queries[0][0].op).toBe('delete');
    expect((step(queries[0], 'where')!.args[0] as any).and[1].sql).toContain('IS NOT NULL');
    results = [[]];
    expect(await svc.purgeById('d-1')).toBe(false);
  });
});

describe('clone', () => {
  const caller = { orgId: 'org-2', userId: 'u-2' };
  const source = {
    ...dash({ name: 'Ops (copy 3)', description: 'desc', layoutJson: { p: { x: 1, y: 1, w: 1, h: 1 } } }),
    panels: [{ id: 'p-1', queryKey: 'k', vizKind: 'bar', title: 't', span: 4, groupBy: null, format: null, position: 0 }],
  };

  it('strips an existing copy suffix and takes the first free name', async () => {
    // base "Ops" taken, "Ops (copy)" free → then create + panel insert
    results = [[{ id: 'x' }], [], [dash({ id: 'd-new', name: 'Ops (copy)' })], [{ id: 'p-new' }]];
    const out = await svc.clone(source, caller);
    expect(out.id).toBe('d-new');
    const created = step(queries[2], 'values')!.args[0] as any;
    expect(created).toMatchObject({ name: 'Ops (copy)', visibility: 'private', orgId: 'org-2', description: 'desc' });
    expect(step(queries[3], 'values')!.args[0]).toEqual([
      { dashboardId: 'd-new', queryKey: 'k', vizKind: 'bar', title: 't', span: 4, groupBy: null, format: null, position: 0 },
    ]);
  });

  it('falls back to a timestamp suffix after 20 collisions', async () => {
    results = Array.from({ length: 21 }, () => [{ id: 'x' }]);
    results.push([dash({ id: 'd-new' })]);
    await svc.clone({ ...source, description: null, panels: [] }, caller);
    const created = step(queries[21], 'values')!.args[0] as any;
    expect(created.name).toMatch(/^Ops \(copy \d{10,}\)$/);
    expect(created.description).toBeNull();
  });
});
