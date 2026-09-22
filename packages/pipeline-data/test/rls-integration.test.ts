// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Row-level security, observed on a REAL Postgres.
 *
 * `postgres-init-rls-drift.test.ts` pins what the init file SAYS; this suite
 * applies the shipped `postgres-init.sql` to an in-process Postgres (PGlite)
 * and checks what the database actually DOES when the application role runs a
 * query under a tenant scope — the only thing that matters for isolation:
 *
 *   - every org-scoped table: another org's rows are invisible and unwritable;
 *     the system org's rows are readable but NOT writable or deletable (the
 *     read carve-out must never be a write carve-out); a row can't be moved to
 *     another org; a sysadmin reaches everything;
 *   - the dedicated policies: templates' public-only system catalog, messages'
 *     recipient read + read-state-only update, attachments following their
 *     message, dashboard panels following their dashboard;
 *   - reflection: every table with an `org_id` has RLS enabled AND forced.
 */

import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import type { PGlite } from '@electric-sql/pglite';
import { SYSTEM_ORG, asTenant, bootInitDb } from './helpers/pglite-init.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

let db: PGlite;

// Booting WASM Postgres and applying the full init script takes a few seconds.
beforeAll(async () => { db = await bootInitDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

// ---------------------------------------------------------------------------
// Generic seeding: one valid row per table per org, from the catalog.
// ---------------------------------------------------------------------------

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  character_maximum_length: number | null;
}

interface ForeignKey { column: string; refTable: string; refColumn: string }

async function columnsOf(table: string): Promise<ColumnInfo[]> {
  return (await db.query<ColumnInfo>(
    `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`, [table])).rows;
}

async function foreignKeysOf(table: string): Promise<ForeignKey[]> {
  return (await db.query<ForeignKey>(
    `SELECT a.attname AS column, cf.relname AS "refTable", af.attname AS "refColumn"
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_class cf ON cf.oid = c.confrelid
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND t.relname = $1`, [table])).rows;
}

/** First literal a CHECK constraint allows for `column`, when it is an enum-style IN list. */
async function allowedLiteral(table: string, column: string): Promise<string | undefined> {
  const defs = (await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'c' AND t.relname = $1`, [table])).rows.map((r) => r.def);
  for (const def of defs) {
    // Only enum-style lists: `col = ANY (ARRAY['a'::text, …])` / `col IN (…)`.
    if (!new RegExp(`\\(?${column}\\)?(?:::text)? = ANY`).test(def)) continue;
    const m = def.match(/'([^']*)'::(?:character varying|text)/);
    if (m) return m[1];
  }
  return undefined;
}

/** Hand-picked values for CHECKs that are not IN-lists. */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  plugins: { version: '1.0.0' },
  plugin_listing_versions: { version: '1.0.0' },
  ecosystem_notification_queue: { event: 'N1' },
};

/**
 * Insert (as the superuser, bypassing RLS) a minimal valid row of `table` owned
 * by `orgId`, recursively creating any required parent row in the same org.
 * Returns the full inserted row.
 */
async function seed(table: string, orgId: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cols = await columnsOf(table);
  const fks = await foreignKeysOf(table);
  const values: Record<string, unknown> = {};
  for (const col of cols) {
    const name = col.column_name;
    if (name in extra) { values[name] = extra[name]; continue; }
    if (name === 'org_id') { values[name] = orgId; continue; }
    if (col.is_nullable === 'YES' || col.column_default !== null) continue;
    const override = OVERRIDES[table]?.[name];
    if (override !== undefined) { values[name] = override; continue; }
    const fk = fks.find((f) => f.column === name);
    if (fk) {
      const parent = await seed(fk.refTable, orgId);
      values[name] = parent[fk.refColumn];
      continue;
    }
    const literal = await allowedLiteral(table, name);
    if (literal !== undefined) { values[name] = literal; continue; }
    switch (col.data_type) {
      case 'uuid': values[name] = randomUUID(); break;
      case 'integer': case 'bigint': case 'smallint': case 'numeric': case 'double precision': case 'real': values[name] = 1; break;
      case 'boolean': values[name] = false; break;
      case 'timestamp with time zone': case 'timestamp without time zone': case 'date': values[name] = new Date().toISOString(); break;
      case 'jsonb': case 'json': values[name] = '{}'; break;
      case 'ARRAY': values[name] = '{}'; break;
      default: {
        const s = `s${randomUUID().replace(/-/g, '')}`;
        values[name] = col.character_maximum_length ? s.slice(0, col.character_maximum_length) : s;
      }
    }
  }
  const names = Object.keys(values);
  const sql = `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
  return (await db.query<Record<string, unknown>>(sql, names.map((n) => values[n]))).rows[0];
}

/** The table's primary key column (every org-scoped table has a single-column PK). */
async function pkOf(table: string): Promise<string> {
  const r = await db.query<{ attname: string }>(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary`, [table]);
  return r.rows[0].attname;
}

/** Tables governed by the GENERIC org-scope policy set (have `org_id` + rls_org_read). */
async function genericTables(): Promise<string[]> {
  const dedicated = new Set(['messages', 'message_attachments', 'pipeline_templates']);
  const r = await db.query<{ tablename: string }>(
    `SELECT DISTINCT p.tablename FROM pg_policies p
       JOIN information_schema.columns c ON c.table_name = p.tablename AND c.column_name = 'org_id'
      WHERE p.policyname = 'rls_org_read' ORDER BY 1`);
  return r.rows.map((x) => x.tablename).filter((t) => !dedicated.has(t));
}

async function expectRlsError(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toThrow(/row-level security|violates|insufficient|permission|may only update read state/i);
}

// ---------------------------------------------------------------------------

describe('reflection: every tenant table is RLS-enabled and FORCEd', () => {
  it('every table with an org_id column has ROW LEVEL SECURITY enabled and forced', async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'org_id')
        ORDER BY 1`);
    expect(r.rows.length).toBeGreaterThanOrEqual(32);
    const bad = r.rows.filter((x) => !x.relrowsecurity || !x.relforcerowsecurity).map((x) => x.relname);
    expect(bad).toEqual([]);
  });

  it('dashboard_panels (scoped through its dashboard) is enabled and forced too', async () => {
    const r = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'dashboard_panels'");
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('no tenant table carries a FOR ALL policy (reads and writes are separate)', async () => {
    const r = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_policies WHERE cmd = 'ALL' AND policyname <> 'rls_ecosystem_app'");
    expect(r.rows).toEqual([]);
  });

  it('the install-time policy helper is not left behind for the app role', async () => {
    const r = await db.query("SELECT 1 FROM pg_proc WHERE proname = 'pb_reset_policies'");
    expect(r.rows).toEqual([]);
  });

  it('the application role cannot bypass RLS', async () => {
    const r = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'pb_app'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('generic org-scoped tables — per-table isolation', () => {
  it('isolates every table: cross-org invisible + unwritable, system readable but not writable', async () => {
    const tables = await genericTables();
    expect(tables.length).toBeGreaterThanOrEqual(28);
    const failures: string[] = [];

    for (const table of tables) {
      const pk = await pkOf(table);
      const a = await seed(table, ORG_A);
      const b = await seed(table, ORG_B);
      const sys = await seed(table, SYSTEM_ORG);
      const check = (cond: boolean, what: string) => { if (!cond) failures.push(`${table}: ${what}`); };

      await asTenant(db, { orgId: ORG_A }, async (q) => {
        const seen = (await q.query<Record<string, unknown>>(`SELECT ${pk} AS id FROM ${table}`)).rows.map((r) => r.id);
        check(seen.includes(a[pk]), 'own row visible');
        check(seen.includes(sys[pk]), 'system row visible');
        check(!seen.includes(b[pk]), 'other org row invisible');

        const updB = await q.query(`UPDATE ${table} SET org_id = org_id WHERE ${pk} = $1`, [b[pk]]);
        check(updB.affectedRows === 0, 'cannot update other org row');
        const updSys = await q.query(`UPDATE ${table} SET org_id = org_id WHERE ${pk} = $1`, [sys[pk]]);
        check(updSys.affectedRows === 0, 'cannot update system row');
        const delB = await q.query(`DELETE FROM ${table} WHERE ${pk} = $1`, [b[pk]]);
        check(delB.affectedRows === 0, 'cannot delete other org row');
        const delSys = await q.query(`DELETE FROM ${table} WHERE ${pk} = $1`, [sys[pk]]);
        check(delSys.affectedRows === 0, 'cannot delete system row');
        const updOwn = await q.query(`UPDATE ${table} SET org_id = org_id WHERE ${pk} = $1`, [a[pk]]);
        check(updOwn.affectedRows === 1, 'can update own row');
      });

      // Moving a row to another org is refused (WITH CHECK on UPDATE).
      await asTenant(db, { orgId: ORG_A }, async (q) => {
        let refused = false;
        try { await q.query(`UPDATE ${table} SET org_id = $2 WHERE ${pk} = $1`, [a[pk], ORG_B]); } catch { refused = true; }
        check(refused, 'cannot move own row to another org');
      });

      // A sysadmin reaches every org's rows.
      await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
        const seen = (await q.query<Record<string, unknown>>(`SELECT ${pk} AS id FROM ${table} WHERE ${pk} = ANY($1)`, [[a[pk], b[pk], sys[pk]]])).rows;
        check(seen.length === 3, 'sysadmin sees all orgs');
        const del = await q.query(`DELETE FROM ${table} WHERE ${pk} = $1`, [b[pk]]);
        check(del.affectedRows === 1, 'sysadmin can delete any org row');
      });

      // No tenant context: only the system carve-out is readable.
      await asTenant(db, {}, async (q) => {
        const seen = (await q.query<Record<string, unknown>>(`SELECT ${pk} AS id FROM ${table} WHERE ${pk} = ANY($1)`, [[a[pk], b[pk]]])).rows;
        check(seen.length === 0, 'no context sees no tenant rows');
      });
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('an INSERT for another org is refused', async () => {
    await expectRlsError(asTenant(db, { orgId: ORG_A }, (q) =>
      q.query('INSERT INTO dora_settings (org_id) VALUES ($1)', [ORG_B])));
  });
});

describe('pipeline_templates — public-only system catalog', () => {
  it('another org sees the system org PUBLIC templates only', async () => {
    const pub = await seed('pipeline_templates', SYSTEM_ORG, { visibility: 'public' });
    const priv = await seed('pipeline_templates', SYSTEM_ORG, { visibility: 'private' });
    const orgRung = await seed('pipeline_templates', SYSTEM_ORG, { visibility: 'org' });
    const other = await seed('pipeline_templates', ORG_B, { visibility: 'public' });
    const own = await seed('pipeline_templates', ORG_A, { visibility: 'private' });
    await asTenant(db, { orgId: ORG_A }, async (q) => {
      const ids = (await q.query<{ id: string }>('SELECT id FROM pipeline_templates')).rows.map((r) => r.id);
      expect(ids).toContain(pub.id);
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(priv.id);
      expect(ids).not.toContain(orgRung.id);
      expect(ids).not.toContain(other.id);
      expect((await q.query('DELETE FROM pipeline_templates WHERE id = $1', [pub.id])).affectedRows).toBe(0);
      expect((await q.query("UPDATE pipeline_templates SET name = 'x' WHERE id = $1", [pub.id])).affectedRows).toBe(0);
    });
  });
});

describe('messages — recipient read + read-state-only update', () => {
  async function message(from: string, to: string, extra: Record<string, unknown> = {}) {
    return seed('messages', from, { recipient_org_id: to, ...extra });
  }

  it('the recipient reads it and stamps read state; a third org sees nothing', async () => {
    const m = await message(ORG_A, ORG_B);
    await asTenant(db, { orgId: ORG_B }, async (q) => {
      expect((await q.query('SELECT id FROM messages WHERE id = $1', [m.id])).rows).toHaveLength(1);
      const upd = await q.query(
        `UPDATE messages SET read_by = coalesce(read_by, '{}'::jsonb) || $2::jsonb, updated_at = now(), updated_by = 'u-b'
          WHERE id = $1 AND NOT (coalesce(read_by, '{}'::jsonb) ? $3) RETURNING read_by`,
        [m.id, JSON.stringify({ [ORG_B]: 'now' }), ORG_B]);
      expect(upd.rows).toHaveLength(1);
    });
    await asTenant(db, { orgId: 'org-c' }, async (q) => {
      expect((await q.query('SELECT id FROM messages WHERE id = $1', [m.id])).rows).toHaveLength(0);
    });
  });

  it('the recipient can NOT rewrite content, re-route, or delete it', async () => {
    const m = await message(ORG_A, ORG_B);
    await expectRlsError(asTenant(db, { orgId: ORG_B }, (q) =>
      q.query("UPDATE messages SET content = 'forged' WHERE id = $1", [m.id])));
    await expectRlsError(asTenant(db, { orgId: ORG_B }, (q) =>
      q.query('UPDATE messages SET recipient_org_id = $2 WHERE id = $1', [m.id, 'org-c'])));
    await expectRlsError(asTenant(db, { orgId: ORG_B }, (q) =>
      q.query('UPDATE messages SET is_active = false, deleted_at = now() WHERE id = $1', [m.id])));
    await asTenant(db, { orgId: ORG_B }, async (q) => {
      expect((await q.query('DELETE FROM messages WHERE id = $1', [m.id])).affectedRows).toBe(0);
    });
  });

  it('a broadcast is readable and read-markable by any org, but not editable', async () => {
    const m = await message(SYSTEM_ORG, '*');
    await asTenant(db, { orgId: ORG_A }, async (q) => {
      const upd = await q.query(
        'UPDATE messages SET read_by = read_by || $2::jsonb WHERE id = $1 RETURNING id', [m.id, JSON.stringify({ [ORG_A]: 'now' })]);
      expect(upd.rows).toHaveLength(1);
      expect((await q.query('DELETE FROM messages WHERE id = $1', [m.id])).affectedRows).toBe(0);
    });
    await expectRlsError(asTenant(db, { orgId: ORG_A }, (q) =>
      q.query("UPDATE messages SET subject = 'forged' WHERE id = $1", [m.id])));
  });

  it('deleteThread: the root sender soft-deletes the whole thread, including the other side’s replies', async () => {
    const root = await message(ORG_A, ORG_B);
    const replyFromB = await message(ORG_B, ORG_A, { thread_id: root.id });
    const replyFromA = await message(ORG_A, ORG_B, { thread_id: root.id });
    await asTenant(db, { orgId: ORG_A }, async (q) => {
      const r = await q.query(
        `UPDATE messages SET is_active = false, deleted_at = now(), deleted_by = 'u-a', updated_at = now(), updated_by = 'u-a'
          WHERE thread_id = $1 AND is_active = true AND (org_id = $2 OR recipient_org_id = $2)`, [root.id, ORG_A]);
      expect(r.affectedRows).toBe(2);
      const alive = await q.query('SELECT id FROM messages WHERE id = ANY($1) AND is_active', [[replyFromA.id, replyFromB.id]]);
      expect(alive.rows).toHaveLength(0);
    });
  });

  it('a participant cannot soft-delete the other side’s messages in a thread it does not own', async () => {
    const root = await message(ORG_A, ORG_B);
    const replyFromA = await message(ORG_A, ORG_B, { thread_id: root.id });
    await expectRlsError(asTenant(db, { orgId: ORG_B }, (q) =>
      q.query('UPDATE messages SET is_active = false, deleted_at = now() WHERE id = $1', [replyFromA.id])));
  });

  it('the sender still edits its own message', async () => {
    const m = await message(ORG_A, ORG_B);
    await asTenant(db, { orgId: ORG_A }, async (q) => {
      expect((await q.query("UPDATE messages SET content = 'edited' WHERE id = $1", [m.id])).affectedRows).toBe(1);
    });
  });
});

describe('message_attachments — follow the message; writes are the uploader’s', () => {
  it('the recipient reads an attachment on a message it received, but cannot delete it', async () => {
    const m = await seed('messages', ORG_A, { recipient_org_id: ORG_B });
    const att = await seed('message_attachments', ORG_A, { message_id: m.id });
    await asTenant(db, { orgId: ORG_B }, async (q) => {
      expect((await q.query('SELECT id FROM message_attachments WHERE id = $1', [att.id])).rows).toHaveLength(1);
      expect((await q.query('DELETE FROM message_attachments WHERE id = $1', [att.id])).affectedRows).toBe(0);
    });
    await asTenant(db, { orgId: 'org-c' }, async (q) => {
      expect((await q.query('SELECT id FROM message_attachments WHERE id = $1', [att.id])).rows).toHaveLength(0);
    });
  });
});

describe('dashboard_panels — scoped through the dashboard', () => {
  it('system panels are readable but not deletable; other orgs’ panels are invisible', async () => {
    const sysPanel = await seed('dashboard_panels', SYSTEM_ORG);
    const bPanel = await seed('dashboard_panels', ORG_B);
    const aPanel = await seed('dashboard_panels', ORG_A);
    await asTenant(db, { orgId: ORG_A }, async (q) => {
      const ids = (await q.query<{ id: string }>('SELECT id FROM dashboard_panels')).rows.map((r) => r.id);
      expect(ids).toContain(sysPanel.id);
      expect(ids).toContain(aPanel.id);
      expect(ids).not.toContain(bPanel.id);
      expect((await q.query('DELETE FROM dashboard_panels WHERE id = $1', [sysPanel.id])).affectedRows).toBe(0);
      expect((await q.query('DELETE FROM dashboard_panels WHERE id = $1', [aPanel.id])).affectedRows).toBe(1);
    });
  });
});
