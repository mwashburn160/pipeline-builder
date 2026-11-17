// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The drizzle schema (what services query with) against the database the
 * shipped `postgres-init.sql` actually builds (PGlite): every drizzle table
 * exists with exactly the same columns, and every foreign key either side
 * declares is declared on the other — with the same target and ON DELETE rule.
 *
 * A column only one side knows about is either dead DDL or a query that fails
 * at runtime; a foreign key only one side knows about is a cascade that either
 * silently doesn't happen or that the code doesn't expect.
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { is, SQL } from 'drizzle-orm';
import { PgDialect, PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as drizzleSchema from '../src/database/drizzle-schema.js';
import { bootInitDb } from '../src/testing/pglite-init.js';

let db: PGlite;
beforeAll(async () => { db = await bootInitDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

/** One drizzle index key as SQL text: a column's name, or an expression rendered by the dialect. */
function drizzleIndexKeyText(key: unknown, dialect: PgDialect): string {
  if (is(key, SQL)) return dialect.sqlToQuery(key).sql;
  const named = key as { name?: string };
  if (typeof named.name === 'string') return named.name;
  throw new Error(`unrecognised index key: ${String(key)}`);
}

/** Drop what differs only in spelling: table qualifiers, identifier quotes and the casts Postgres adds to literals. */
function stripSpelling(text: string): string {
  return text
    .replace(/"[a-z0-9_]+"\./g, '') // table qualifier
    .replace(/"/g, '')
    .replace(/::(text|character varying|timestamp with time zone|integer|boolean)(\[\])?/gi, '');
}

/**
 * Index-key text in a comparable form: Postgres deparses `coalesce(pipeline_id::text, ''::text)`
 * where drizzle renders `coalesce("pipeline_events"."pipeline_id"::text, '')`, and a
 * drizzle key may carry `DESC` or an operator class that pg_get_indexdef's
 * per-column form omits.
 */
function normalizeIndexKey(text: string): string {
  return stripSpelling(text)
    .replace(/\s+(asc|desc)(\s+nulls\s+(first|last))?\s*$/i, '')
    .replace(/\s+[a-z0-9_]+_ops\s*$/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * Predicate text in a comparable form. Postgres re-parenthesizes and casts
 * literals (`'x'::text`, `IN (...)` → `= ANY (ARRAY[...])`), so both sides
 * drop parens, whitespace, quotes-as-identifiers and the redundant casts.
 */
function normalizePredicate(text: string): string {
  return stripSpelling(text)
    .replace(/\s+in\s*\(([^)]*)\)/gi, (_m, list: string) => `=ANY(ARRAY[${list}])`)
    .replace(/[()\s]/g, '')
    .toLowerCase();
}

const TABLES: PgTable[] = (Object.values(drizzleSchema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

/** drizzle's `onDelete` spelling → pg_constraint.confdeltype. */
const ON_DELETE: Record<string, string> = {
  'no action': 'a', 'restrict': 'r', 'cascade': 'c', 'set null': 'n', 'set default': 'd',
};

describe('drizzle schema ⇔ postgres-init.sql', () => {
  it('covers a meaningful set of tables', () => {
    expect(TABLES.length).toBeGreaterThanOrEqual(50);
  });

  it('every drizzle table exists with exactly the same columns', async () => {
    const mismatches: string[] = [];
    for (const table of TABLES) {
      const cfg = getTableConfig(table);
      const r = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [cfg.name]);
      const sqlCols = new Set(r.rows.map((x) => x.column_name));
      if (sqlCols.size === 0) { mismatches.push(`${cfg.name}: table missing from SQL`); continue; }
      const drizzleCols = new Set(cfg.columns.map((c) => c.name));
      for (const c of drizzleCols) if (!sqlCols.has(c)) mismatches.push(`${cfg.name}.${c}: in drizzle, not in SQL`);
      for (const c of sqlCols) if (!drizzleCols.has(c)) mismatches.push(`${cfg.name}.${c}: in SQL, not in drizzle`);
    }
    expect(mismatches).toEqual([]);
  });

  it('foreign keys agree on both sides (target and ON DELETE)', async () => {
    const mismatches: string[] = [];
    for (const table of TABLES) {
      const cfg = getTableConfig(table);
      const drizzleFks = new Map<string, string>();
      for (const fk of cfg.foreignKeys) {
        const ref = fk.reference();
        const col = ref.columns[0].name;
        const target = `${getTableConfig(ref.foreignTable).name}.${ref.foreignColumns[0].name}`;
        drizzleFks.set(col, `${target} ${ON_DELETE[fk.onDelete ?? 'no action']}`);
      }
      const r = await db.query<{ col: string; target: string; deltype: string }>(
        `SELECT a.attname AS col, cf.relname || '.' || af.attname AS target, c.confdeltype AS deltype
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_class cf ON cf.oid = c.confrelid
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
           JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
          WHERE c.contype = 'f' AND t.relname = $1`, [cfg.name]);
      const sqlFks = new Map(r.rows.map((x) => [x.col, `${x.target} ${x.deltype}`]));
      for (const [col, want] of drizzleFks) {
        if (sqlFks.get(col) !== want) mismatches.push(`${cfg.name}.${col}: drizzle ${want} vs SQL ${sqlFks.get(col) ?? 'none'}`);
      }
      for (const [col, have] of sqlFks) {
        if (!drizzleFks.has(col)) mismatches.push(`${cfg.name}.${col}: SQL ${have}, not in drizzle`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every drizzle index exists in SQL under the same name', async () => {
    const r = await db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
    const sqlIndexes = new Set(r.rows.map((x) => x.indexname));
    const missing: string[] = [];
    for (const table of TABLES) {
      const cfg = getTableConfig(table);
      for (const idx of cfg.indexes) {
        if (idx.config.name && !sqlIndexes.has(idx.config.name)) missing.push(`${cfg.name}: ${idx.config.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every drizzle index has the same columns, uniqueness and predicate as its SQL twin', async () => {
    // Per-key definitions (column name or expression text, without ASC/DESC —
    // those live in indoption) + the partial-index predicate, as Postgres
    // deparses them. A same-NAME index on different columns is the drift this
    // catches: the planner silently stops using it for the query it was for.
    const r = await db.query<{ indexname: string; tablename: string; is_unique: boolean; keys: string[]; pred: string | null }>(
      `SELECT ic.relname AS indexname, t.relname AS tablename, ix.indisunique AS is_unique,
              ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true) FROM generate_series(1, ix.indnkeyatts) AS k) AS keys,
              pg_get_expr(ix.indpred, ix.indrelid, true) AS pred
         FROM pg_index ix
         JOIN pg_class ic ON ic.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'`);
    const sqlByName = new Map(r.rows.map((x) => [x.indexname, x]));
    const dialect = new PgDialect();
    const mismatches: string[] = [];
    for (const table of TABLES) {
      const cfg = getTableConfig(table);
      for (const idx of cfg.indexes) {
        const name = idx.config.name;
        const have = name ? sqlByName.get(name) : undefined;
        if (!name || !have) continue; // presence is the previous test's job
        if (have.tablename !== cfg.name) mismatches.push(`${name}: on ${have.tablename} in SQL, ${cfg.name} in drizzle`);
        if (have.is_unique !== !!idx.config.unique) mismatches.push(`${name}: unique ${have.is_unique} in SQL, ${!!idx.config.unique} in drizzle`);
        const want = idx.config.columns.map((c) => normalizeIndexKey(drizzleIndexKeyText(c, dialect)));
        const got = have.keys.map(normalizeIndexKey);
        if (JSON.stringify(want) !== JSON.stringify(got)) {
          mismatches.push(`${name}: columns drizzle (${want.join(', ')}) vs SQL (${got.join(', ')})`);
        }
        const wantPred = idx.config.where ? normalizePredicate(dialect.sqlToQuery(idx.config.where).sql) : null;
        const gotPred = have.pred ? normalizePredicate(have.pred) : null;
        if (wantPred !== gotPred) mismatches.push(`${name}: predicate drizzle ${wantPred ?? 'none'} vs SQL ${gotPred ?? 'none'}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every SQL index on a drizzle table is declared in drizzle (bar primary keys / constraints)', async () => {
    const tableNames = new Set(TABLES.map((t) => getTableConfig(t).name));
    const declared = new Set(TABLES.flatMap((t) => getTableConfig(t).indexes.map((i) => i.config.name)));
    const r = await db.query<{ tablename: string; indexname: string }>(
      `SELECT i.tablename, i.indexname FROM pg_indexes i
        WHERE i.schemaname = 'public'
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname)`);
    const undeclared = r.rows
      .filter((x) => tableNames.has(x.tablename) && !declared.has(x.indexname))
      .map((x) => `${x.tablename}: ${x.indexname}`);
    expect(undeclared).toEqual([]);
  });
});
