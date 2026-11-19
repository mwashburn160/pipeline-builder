// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org purge executor every owning service runs for its own slice, against a
 * REAL Postgres (PGlite + the shipped init script: RLS, FORCE, the app role).
 *
 * What it pins:
 *  - OWNERSHIP is total and exclusive: every table with an `org_id` column is
 *    owned by exactly one service (schema reflection) — a new table nobody
 *    owns would outlive every purged org;
 *  - every owner's statements RUN against the real schema (a soft table that
 *    lacks `purge_after`, or a renamed column, fails here rather than in the
 *    first production purge);
 *  - soft tables are tombstoned with `purge_after = deleted_at`, hard tables
 *    removed, and ONLY the purged org's rows are touched — under a sysadmin
 *    context, since the purged org is never the caller's;
 *  - a second run is a no-op that still succeeds (the outbox redelivers).
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { ORG_DATA_OWNERSHIP, ORG_SCOPED_TABLE_NAMES, allOrgScopedTables, type OrgDataOwner } from '../src/api/org-data-ownership.js';
import { purgeOrgData, purgeRowCounts, resetPurgeTableCacheForTesting } from '../src/api/org-data-purge.js';
import { schema } from '../src/database/drizzle-schema.js';
import { bootTenantDb, type TenantTestDb } from '../src/testing/index.js';

let tdb: TenantTestDb;
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'org-purged';
const OTHER = 'org-kept';
const OWNERS = Object.keys(ORG_DATA_OWNERSHIP) as OrgDataOwner[];

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await owner((q) => q.exec('DELETE FROM dashboards; DELETE FROM dora_settings; DELETE FROM support_case_counters;'));
});

describe('ORG_DATA_OWNERSHIP', () => {
  it('owns EVERY org-scoped table (schema reflection)', () => {
    const uncovered: string[] = [];
    for (const val of Object.values(schema)) {
      if (!is(val, PgTable)) continue;
      const cols = getTableColumns(val as never);
      if (!Object.values(cols).some((c) => (c as { name: string }).name === 'org_id')) continue;
      const name = getTableName(val as never);
      if (!ORG_SCOPED_TABLE_NAMES.has(name)) uncovered.push(name);
    }
    expect(uncovered).toEqual([]);
  });

  it('gives each table exactly ONE owner, under its real Postgres name', () => {
    const all = allOrgScopedTables();
    expect(new Set(all.map((t) => t.name)).size).toBe(all.length);
    for (const { table, name } of all) expect(getTableName(table as never)).toBe(name);
  });

  it('puts only tables WITH deleted_at + purge_after on the soft side', () => {
    for (const slice of Object.values(ORG_DATA_OWNERSHIP)) {
      for (const { table, name } of slice.soft) {
        const cols = Object.values(getTableColumns(table as never)).map((c) => (c as { name: string }).name);
        expect([name, cols.includes('deleted_at') && cols.includes('purge_after')]).toEqual([name, true]);
      }
    }
  });
});

describe('purgeOrgData (real Postgres, RLS)', () => {
  it.each(OWNERS)('%s: every statement of its slice runs against the real schema', async (who) => {
    const result = await purgeOrgData(who, ORG);
    expect(result.failed).toEqual([]);
    const slice = ORG_DATA_OWNERSHIP[who];
    expect(Object.keys(result.tables).sort()).toEqual([...slice.soft, ...slice.hard].map((t) => t.name).sort());
  });

  it('tombstones soft rows with purge_after = deleted_at, and only the purged org\'s', async () => {
    await owner((q) => q.query(
      'INSERT INTO dashboards (org_id, name) VALUES ($1, $2), ($1, $3), ($4, $2)',
      [ORG, 'a', 'b', OTHER],
    ));

    const result = await purgeOrgData('ops-center', ORG);
    expect(purgeRowCounts(result).dashboards).toBe(2);

    const { rows } = await owner((q) => q.query<{ org_id: string; deleted_at: Date | null; purge_after: Date | null }>(
      'SELECT org_id, deleted_at, purge_after FROM dashboards ORDER BY org_id',
    ));
    const purged = rows.filter((r) => r.org_id === ORG);
    expect(purged).toHaveLength(2);
    for (const r of purged) {
      expect(r.deleted_at).not.toBeNull();
      // Same instant: immediately eligible for the owner's retention sweep.
      expect(r.purge_after?.getTime()).toBe(r.deleted_at?.getTime());
    }
    expect(rows.find((r) => r.org_id === OTHER)).toMatchObject({ deleted_at: null });
  });

  it('deactivates soft rows that carry is_active, so list reads stop returning them', async () => {
    await owner((q) => q.query(
      'INSERT INTO compliance_policies (org_id, name, created_by, updated_by) VALUES ($1, $2, $3, $3), ($4, $2, $3, $3)',
      [ORG, 'p', 'u', OTHER],
    ));

    const result = await purgeOrgData('compliance', ORG);
    expect(result.failed).toEqual([]);
    expect(purgeRowCounts(result).compliance_policies).toBe(1);

    const { rows } = await owner((q) => q.query<{ org_id: string; is_active: boolean; deleted_at: Date | null }>(
      'SELECT org_id, is_active, deleted_at FROM compliance_policies ORDER BY org_id',
    ));
    expect(rows.find((r) => r.org_id === ORG)).toMatchObject({ is_active: false });
    expect(rows.find((r) => r.org_id === ORG)?.deleted_at).not.toBeNull();
    expect(rows.find((r) => r.org_id === OTHER)).toMatchObject({ is_active: true, deleted_at: null });
    await owner((q) => q.exec('DELETE FROM compliance_policies'));
  });

  it('removes hard rows, and only the purged org\'s', async () => {
    await owner((q) => q.query('INSERT INTO dora_settings (org_id) VALUES ($1), ($2)', [ORG, OTHER]));
    await owner((q) => q.query('INSERT INTO support_case_counters (org_id) VALUES ($1), ($2)', [ORG, OTHER]));

    const reporting = await purgeOrgData('reporting', ORG);
    const message = await purgeOrgData('message', ORG);
    expect(purgeRowCounts(reporting).dora_settings).toBe(1);
    expect(purgeRowCounts(message).support_case_counters).toBe(1);

    const left = await owner((q) => q.query<{ org_id: string }>(
      'SELECT org_id FROM dora_settings UNION ALL SELECT org_id FROM support_case_counters',
    ));
    expect(left.rows.map((r) => r.org_id)).toEqual([OTHER, OTHER]);
  });

  it('is idempotent: a redelivered purge matches nothing and still succeeds', async () => {
    await owner((q) => q.query('INSERT INTO dashboards (org_id, name) VALUES ($1, $2)', [ORG, 'a']));
    await owner((q) => q.query('INSERT INTO dora_settings (org_id) VALUES ($1)', [ORG]));

    expect(purgeRowCounts(await purgeOrgData('ops-center', ORG)).dashboards).toBe(1);
    const again = await purgeOrgData('ops-center', ORG);
    expect(again.failed).toEqual([]);
    // Already tombstoned ⇒ not re-stamped (its purge deadline is not pushed out).
    expect(purgeRowCounts(again).dashboards).toBe(0);

    expect(purgeRowCounts(await purgeOrgData('reporting', ORG)).dora_settings).toBe(1);
    expect(purgeRowCounts(await purgeOrgData('reporting', ORG)).dora_settings).toBe(0);
  });

  it('refuses an empty org id rather than matching every row', async () => {
    await expect(purgeOrgData('platform', '')).rejects.toThrow(/orgId is required/);
  });
});

describe('purgeOrgData — a failing table', () => {
  it('names the table in `failed`, keeps going, and never throws', async () => {
    // Break one table of the slice for the duration of the test.
    await owner((q) => q.exec('ALTER TABLE support_case_counters RENAME COLUMN org_id TO org_id_gone'));
    try {
      const result = await purgeOrgData('message', ORG);
      expect(result.failed).toEqual(['support_case_counters']);
      expect(result.tables.support_case_counters).toMatchObject({ ok: false });
      // The other tables of the slice still ran.
      expect(result.tables.messages).toMatchObject({ ok: true });
      expect(result.tables.support_case_notes).toMatchObject({ ok: true });
      // Counts only — the failed table is left out.
      expect(purgeRowCounts(result)).not.toHaveProperty('support_case_counters');
    } finally {
      await owner((q) => q.exec('ALTER TABLE support_case_counters RENAME COLUMN org_id_gone TO org_id'));
    }
  });
});

describe('a database created before a table shipped (init script = new installs only)', () => {
  const insertRunner = (org: string) => owner((q) => q.query(
    "INSERT INTO pipeline_runners (org_id, label, function_url) VALUES ($1, 'r', 'https://abc.lambda-url.us-east-1.on.aws/')", [org]));

  it('still purges the runner tables when they exist', async () => {
    resetPurgeTableCacheForTesting();
    await insertRunner(ORG);
    await insertRunner(OTHER);
    const result = await purgeOrgData('pipeline', ORG);
    expect(result.failed).toEqual([]);
    expect(result.absent).toEqual([]);
    expect(result.tables.pipeline_runners).toEqual({ ok: true, rowCount: 1 });
    const left = await owner((q) => q.query<{ org_id: string }>('SELECT org_id FROM pipeline_runners'));
    expect(left.rows.map((r) => r.org_id)).toEqual([OTHER]);
    await owner((q) => q.exec('DELETE FROM pipeline_runners'));
  });

  it('skips a missing table, names it in `absent`, and does not fail the purge', async () => {
    resetPurgeTableCacheForTesting();
    await owner((q) => q.exec('ALTER TABLE pipeline_run_requests RENAME TO pipeline_run_requests_hidden; ALTER TABLE pipeline_runners RENAME TO pipeline_runners_hidden;'));
    try {
      const result = await purgeOrgData('pipeline', ORG);
      expect(result.failed).toEqual([]);
      expect(result.absent.sort()).toEqual(['pipeline_run_requests', 'pipeline_runners']);
      expect(result.tables.pipeline_runners).toEqual({ ok: true, rowCount: 0, absent: true });
      // The tables that DO exist are still purged and reported.
      expect(result.tables.pipelines).toMatchObject({ ok: true });
      expect(purgeRowCounts(result)).toMatchObject({ pipeline_runners: 0, pipeline_run_requests: 0 });
    } finally {
      await owner((q) => q.exec('ALTER TABLE pipeline_run_requests_hidden RENAME TO pipeline_run_requests; ALTER TABLE pipeline_runners_hidden RENAME TO pipeline_runners;'));
      resetPurgeTableCacheForTesting();
    }
  });
});
