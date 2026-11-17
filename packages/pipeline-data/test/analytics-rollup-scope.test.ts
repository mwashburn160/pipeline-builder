// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The analytics queries' org scope and day bounds.
 *
 *  - A team rollup runs under the SAME sysadmin elevation `runReport` uses for
 *    DORA / success rate: FORCE RLS on `execution_daily_rollups` and friends
 *    otherwise filters every child team's rows out of a parent org's report.
 *    The elevated read is bounded by `orgScope()`'s validated id list, bound as
 *    one `= ANY($ids::text[])` parameter.
 *  - A single-org read is NOT elevated.
 *  - Rollup `day` (a UTC-midnight stamp) is compared against the period's LOCAL
 *    calendar dates in the report's timezone, not the local-midnight instants.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { fakeTx, type FakeTx } from './helpers/fake-tx.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

let tx: FakeTx;
let elevated = false;
/** The elevation in force at each `withTenantTxRead` call, in order. */
const readContexts: boolean[] = [];
const elevations: unknown[] = [];

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (t: unknown) => unknown) => fn(tx.tx),
  withTenantTxRead: (fn: (t: unknown) => unknown) => { readContexts.push(elevated); return fn(tx.tx); },
  runWithTenantContext: async <T>(ctx: { isSuperAdmin?: boolean }, fn: () => Promise<T>) => {
    elevations.push(ctx);
    const was = elevated;
    elevated = ctx.isSuperAdmin === true;
    try { return await fn(); } finally { elevated = was; }
  },
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const q = await import('../src/api/reporting/analytics-queries.js');

const dialect = new PgDialect();
const render = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);
/** Rendered SQL + params of every raw `execute`, in order. */
const executed = () => tx.of('execute').map((r) => render(r.arg('execute')));
/** The first raw `execute`'s rendered SQL + params. */
const first = (): { sql: string; params: unknown[] } => {
  const [q0] = executed();
  if (!q0) throw new Error('no execute recorded');
  return q0;
};

const SINGLE = { orgId: 'acme', from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };
const ROLLUP = { ...SINGLE, orgIds: ['acme', 'team-1', 'team-2'] };

beforeEach(() => {
  tx = fakeTx();
  elevated = false;
  readContexts.length = 0;
  elevations.length = 0;
});

describe('team rollup: elevated read bounded by the orgScope id list', () => {
  const readers: Array<[string, (s: typeof ROLLUP) => Promise<unknown>]> = [
    ['getPipelineBreakdown', (s) => q.getPipelineBreakdown(s)],
    ['getFailureAnalysis', (s) => q.getFailureAnalysis(s, { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' })],
    ['getResourceConsumption', (s) => q.getResourceConsumption(s)],
    ['getPromotionView', (s) => q.getPromotionView(s)],
    ['getOutdatedPlugins', (s) => q.getOutdatedPlugins(s)],
    ['getPluginVulnerabilities', (s) => q.getPluginVulnerabilities(s)],
    ['getAdoption', (s) => q.getAdoption(s)],
    ['getPipelineStreaks', (s) => q.getPipelineStreaks(s)],
    ['getUntrackedPipelines', (s) => q.getUntrackedPipelines(s)],
    ['getVulnerablePipelines', (s) => q.getVulnerablePipelines(s)],
    ['getPipelineConfigChanges', (s) => q.getPipelineConfigChanges(s)],
  ];

  it.each(readers)('%s runs every read under sysadmin context, scoped by = ANY(ids)', async (_name, run) => {
    await run(ROLLUP);
    expect(readContexts.length).toBeGreaterThan(0);
    expect(readContexts.every(Boolean)).toBe(true);
    expect(elevations.every((c) => (c as { isSuperAdmin: boolean }).isSuperAdmin === true)).toBe(true);
    for (const { sql, params } of executed()) {
      expect(sql).toMatch(/org_id = ANY\(\$\d+::text\[\]\)/);
      expect(params).toContainEqual(['acme', 'team-1', 'team-2']);
      expect(params).not.toContain('acme'); // never a bare single-org bind on the rollup path
    }
  });

  it('getStagePerformance (query builder) is elevated and IN-scoped over the ids', async () => {
    await q.getStagePerformance(ROLLUP, 'p1');
    expect(readContexts).toEqual([true]);
    const where = tx.of('select')[0]!.whereSql();
    expect(where).toMatch(/"org_id" in \(\$1, \$2, \$3\)/);
  });

  /** A list that omits the requesting org is spoofed/malformed — never elevated. */
  it('collapses to the single-org, non-elevated read when the anchor org is absent', async () => {
    await q.getPipelineBreakdown({ ...SINGLE, orgIds: ['other-1', 'other-2'] });
    expect(readContexts).toEqual([false]);
    expect(elevations).toEqual([]);
    const { sql, params } = first();
    expect(sql).not.toMatch(/ANY/);
    expect(params).toContain('acme');
    expect(params).not.toContain('other-1');
  });
});

describe('single org: tenant-scoped read, not elevated', () => {
  it('binds the org as = $org and never elevates', async () => {
    await q.getPipelineBreakdown(SINGLE);
    await q.getStagePerformance(SINGLE, 'p1');
    expect(readContexts).toEqual([false, false]);
    expect(elevations).toEqual([]);
    const { sql, params } = first();
    expect(sql).not.toMatch(/ANY/);
    expect(params).toContain('acme');
  });

  it('a one-element orgIds (self only) is a single-org read', async () => {
    await q.getAdoption({ ...SINGLE, orgIds: ['acme'] });
    expect(readContexts).toEqual([false]);
  });
});

describe('rollupDayBound: local calendar dates in the report timezone', () => {
  it('UTC: a UTC midnight maps to itself', () => {
    expect(q.rollupDayBound('2026-09-01T00:00:00.000Z')).toBe('2026-09-01T00:00:00.000Z');
    expect(q.rollupDayBound('2026-09-01T00:00:00.000Z', 'UTC')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('America/Chicago (CDT, UTC-5): local midnight Sept 1 is 05:00Z → day 2026-09-01', () => {
    expect(q.rollupDayBound('2026-09-01T05:00:00.000Z', 'America/Chicago')).toBe('2026-09-01T00:00:00.000Z');
    expect(q.rollupDayBound('2026-10-01T05:00:00.000Z', 'America/Chicago')).toBe('2026-10-01T00:00:00.000Z');
  });

  it('America/Chicago across the DST change (CST, UTC-6)', () => {
    expect(q.rollupDayBound('2026-12-01T06:00:00.000Z', 'America/Chicago')).toBe('2026-12-01T00:00:00.000Z');
  });

  it('Asia/Tokyo (UTC+9): local midnight Sept 1 is Aug 31 15:00Z → day 2026-09-01', () => {
    expect(q.rollupDayBound('2026-08-31T15:00:00.000Z', 'Asia/Tokyo')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a bound that is not a local midnight rounds up (partial first day out, partial last day in)', () => {
    expect(q.rollupDayBound('2026-09-01T10:00:00.000Z')).toBe('2026-09-02T00:00:00.000Z');
    expect(q.rollupDayBound('2026-09-01T10:00:00.000Z', 'America/Chicago')).toBe('2026-09-02T00:00:00.000Z');
  });

  it('passes an unparseable bound through unchanged', () => {
    expect(q.rollupDayBound('not-a-date', 'America/Chicago')).toBe('not-a-date');
  });
});

describe('day predicates use the local-date bounds; instants stay instants', () => {
  it('America/Chicago: rollup day bounds are the local dates, deploy bounds the raw instants', async () => {
    const from = '2026-09-01T05:00:00.000Z';
    const to = '2026-10-01T05:00:00.000Z';
    await q.getPipelineBreakdown({ orgId: 'acme', from, to, tz: 'America/Chicago' });
    const { params } = first();
    expect(params).toEqual(expect.arrayContaining([
      '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', // r.day bounds
      from, to, // dora_deployments.deployed_at bounds
    ]));
  });

  it('Asia/Tokyo: the period Sept 1..Oct 1 local reads days Sept 1..Sept 30', async () => {
    await q.getUntrackedPipelines({
      orgId: 'acme', from: '2026-08-31T15:00:00.000Z', to: '2026-09-30T15:00:00.000Z', tz: 'Asia/Tokyo',
    });
    const { params } = first();
    expect(params).toEqual(expect.arrayContaining(['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']));
    expect(params).not.toContain('2026-08-31T00:00:00.000Z');
  });

  it('the stage drill-down (query builder) uses the same local-date bounds', async () => {
    await q.getStagePerformance({ orgId: 'acme', from: '2026-09-01T05:00:00.000Z', to: '2026-10-01T05:00:00.000Z', tz: 'America/Chicago' }, 'p1');
    const where = tx.of('select')[0]!.arg('where');
    const { params } = render(where);
    expect(params).toEqual(expect.arrayContaining([
      new Date('2026-09-01T00:00:00.000Z').toISOString(), new Date('2026-10-01T00:00:00.000Z').toISOString(),
    ]));
  });

  it('the streak lookback counts back from the local-date end bound', async () => {
    await q.getPipelineStreaks({ orgId: 'acme', from: '2026-09-01T05:00:00.000Z', to: '2026-10-01T05:00:00.000Z', tz: 'America/Chicago' }, 30);
    const { params } = first();
    expect(params).toEqual(expect.arrayContaining(['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']));
  });

  it('an unknown timezone falls back to UTC rather than failing the section', async () => {
    await q.getUntrackedPipelines({ ...SINGLE, tz: 'Not/AZone' });
    const { params } = first();
    expect(params).toEqual(expect.arrayContaining(['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']));
  });
});
