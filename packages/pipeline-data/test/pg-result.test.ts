// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { REPO_ROOT } from './helpers/pglite-init.js';
import { anyText, executeRows, isUniqueViolation, resultRows } from '../src/database/pg-result.js';

describe('isUniqueViolation', () => {
  it('matches a top-level 23505', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });
  it('matches a wrapped driver error via cause', () => {
    expect(isUniqueViolation(new Error('wrap', { cause: { code: '23505' } }))).toBe(true);
  });
  it('rejects other codes and non-objects', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('resultRows / executeRows', () => {
  it('normalises { rows } and bare arrays', () => {
    expect(resultRows<number>({ rows: [1, 2] })).toEqual([1, 2]);
    expect(resultRows<number>([3])).toEqual([3]);
    expect(resultRows<number>(undefined)).toEqual([]);
    expect(resultRows<number>({ rows: 'x' })).toEqual([]);
  });
  it('executes and returns rows', async () => {
    const executor = { execute: jest.fn(async () => ({ rows: [{ a: 1 }] })) };
    await expect(executeRows<{ a: number }>(executor, sql`SELECT 1 AS a`)).resolves.toEqual([{ a: 1 }]);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});

/**
 * `anyText` on a REAL Postgres. The bug it exists for: Drizzle expands a JS
 * array interpolated into `ANY(${...})` into `ANY(($1, $2))`, which Postgres
 * rejects, and every unit test that mocks `execute` renders it happily.
 */
describe('anyText', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE t (v VARCHAR(71)); INSERT INTO t VALUES (\'a\'), (\'b\'), (\'c\');');
  });
  afterAll(async () => { await db?.close(); });

  const match = async (values: string[]): Promise<string[]> => {
    const q = new PgDialect().sqlToQuery(sql`SELECT v FROM t WHERE v = ${anyText(values)} ORDER BY v`);
    return (await db.query<{ v: string }>(q.sql, q.params as unknown[])).rows.map((r) => r.v);
  };

  it('binds the whole list as ONE parameter', () => {
    const q = new PgDialect().sqlToQuery(sql`v = ${anyText(['a', 'b'])}`);
    expect(q.sql).toBe('v = ANY($1::text[])');
    expect(q.params).toEqual([['a', 'b']]);
  });

  it.each([
    [['a'], ['a']],
    [['a', 'c'], ['a', 'c']],
    [['z'], []],
    [[], []],
  ])('%j matches %j', async (values, expected) => {
    expect(await match(values)).toEqual(expected);
  });

  it('the raw interpolation it replaces really does fail on Postgres', async () => {
    const q = new PgDialect().sqlToQuery(sql`SELECT v FROM t WHERE v = ANY(${['a', 'b']})`);
    await expect(db.query(q.sql, q.params as unknown[])).rejects.toThrow(/array/);
  });

  it('no source file interpolates an array straight into ANY/ALL', () => {
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '-nE', '(ANY|ALL)\\(\\$\\{', '--', 'api/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
        { cwd: REPO_ROOT, encoding: 'utf8' });
    } catch (e) {
      // git grep exits 1 when nothing matches: the clean case.
      if ((e as { status?: number }).status !== 1) throw e;
    }
    // pg-result.ts names the anti-pattern in its own doc comment.
    expect(hits.split('\n').filter((l) => l && !l.includes('src/database/pg-result.ts'))).toEqual([]);
  });
});
