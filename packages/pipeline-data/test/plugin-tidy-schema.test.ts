// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic plugin version tidying schema (postgres-init.sql, real SQL on
 * PGlite): the plugins modtime trigger's WHEN clause (a `last_used_at`-only
 * write is bookkeeping and leaves `updated_at`, the editor's optimistic
 * concurrency token, alone), and plugin_retention_settings' defaults, CHECKs
 * and own-org RLS.
 */

import { randomUUID } from 'crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { bootTenantDb, type TenantTestDb } from '../src/testing/index.js';
import { SYSTEM_ORG, asTenant } from '../src/testing/pglite-init.js';

let tdb: TenantTestDb;
let db: PGlite;
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);
const ORG_A = 'org-tidy-a';
const ORG_B = 'org-tidy-b';
const PAST = '2020-01-01T00:00:00Z';

beforeAll(async () => {
  tdb = await bootTenantDb();
  db = tdb.pglite;
}, 120_000);
afterAll(async () => { await tdb?.close(); });

/** A plugin row whose updated_at is pinned in the past, so any trigger bump is visible. */
async function stalePlugin(): Promise<string> {
  const id = (await owner((q) => q.query<{ id: string }>(
    'INSERT INTO plugins (org_id, name, version) VALUES ($1, $2, \'1.0.0\') RETURNING id', [ORG_A, `t-${randomUUID().slice(0, 8)}`]))).rows[0]!.id;
  // Setting ONLY updated_at is a non-last_used_at change, so the trigger would
  // overwrite it; disable the trigger for this one bookkeeping write.
  await owner(async (q) => {
    await q.query('ALTER TABLE plugins DISABLE TRIGGER update_plugins_modtime');
    try { await q.query('UPDATE plugins SET updated_at = $2 WHERE id = $1', [id, PAST]); } finally {
      await q.query('ALTER TABLE plugins ENABLE TRIGGER update_plugins_modtime');
    }
  });
  return id;
}

const updatedAt = async (id: string): Promise<string> => new Date((await owner((q) => q.query<{ updated_at: string }>(
  'SELECT updated_at FROM plugins WHERE id = $1', [id]))).rows[0]!.updated_at).toISOString();

describe('plugins modtime trigger — last_used_at is bookkeeping', () => {
  it('a write of last_used_at alone leaves updated_at unchanged', async () => {
    const id = await stalePlugin();
    await owner((q) => q.query('UPDATE plugins SET last_used_at = now() WHERE id = $1', [id]));
    expect(await updatedAt(id)).toBe(new Date(PAST).toISOString());
  });

  it('a write that changes last_used_at AND another column bumps updated_at', async () => {
    const id = await stalePlugin();
    await owner((q) => q.query('UPDATE plugins SET last_used_at = now(), tidy_warned_at = NULL, is_active = false WHERE id = $1', [id]));
    expect(await updatedAt(id)).not.toBe(new Date(PAST).toISOString());
  });

  it('a write of any other column bumps updated_at as before', async () => {
    const id = await stalePlugin();
    await owner((q) => q.query('UPDATE plugins SET tidy_kept_at = now() WHERE id = $1', [id]));
    expect(await updatedAt(id)).not.toBe(new Date(PAST).toISOString());
  });
});

describe('plugin_retention_settings', () => {
  it('defaults to notify / 90 days / no never-tidy names, and refuses an unknown mode or a stale window under 30 days', async () => {
    const org = `ret-${randomUUID().slice(0, 8)}`;
    const r = await owner((q) => q.query('INSERT INTO plugin_retention_settings (org_id) VALUES ($1) RETURNING auto_tidy, stale_after_days, never_tidy, last_digest_at', [org]));
    expect(r.rows[0]).toEqual({ auto_tidy: 'notify', stale_after_days: 90, never_tidy: [], last_digest_at: null });
    await expect(owner((q) => q.query("UPDATE plugin_retention_settings SET auto_tidy = 'always' WHERE org_id = $1", [org]))).rejects.toThrow(/check/i);
    await expect(owner((q) => q.query('UPDATE plugin_retention_settings SET stale_after_days = 29 WHERE org_id = $1', [org]))).rejects.toThrow(/check/i);
  });

  it('is RLS-enabled, FORCEd and own-org only (no system-org read carve-out)', async () => {
    const rel = (await owner((q) => q.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'plugin_retention_settings'"))).rows;
    expect(rel).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    await owner((q) => q.query('INSERT INTO plugin_retention_settings (org_id) VALUES ($1), ($2), ($3) ON CONFLICT DO NOTHING', [ORG_A, ORG_B, SYSTEM_ORG]));
    await asTenant(db, { orgId: ORG_A }, async (q) => {
      const seen = (await q.query<{ org_id: string }>('SELECT org_id FROM plugin_retention_settings WHERE org_id = ANY($1) ORDER BY 1', [[ORG_A, ORG_B, SYSTEM_ORG]])).rows;
      expect(seen).toEqual([{ org_id: ORG_A }]);
      expect((await q.query('UPDATE plugin_retention_settings SET auto_tidy = \'off\' WHERE org_id = ANY($1)', [[ORG_B, SYSTEM_ORG]])).affectedRows).toBe(0);
    });
    await expect(asTenant(db, { orgId: ORG_A }, (q) => q.query('INSERT INTO plugin_retention_settings (org_id) VALUES ($1)', [`${ORG_B}-x`])))
      .rejects.toThrow(/row-level security|violates/i);
  });
});
