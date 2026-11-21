// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A jsonb column reads back exactly the value written, on a REAL Postgres.
 *
 * Both drivers (node-postgres, PGlite) already parse json/jsonb, and drizzle's
 * stock `PgJsonb.mapFromDriverValue` JSON.parses any string again — so a jsonb
 * holding a string that looks like a JSON literal ("true", "1", "null", "[]")
 * came back as a boolean / number / null / array. `plugins.smoke_test: "true"`
 * read as `true`, so the smoke command was '' and remediation fixes were forced
 * to propose. The schema's own `jsonb` (schema/jsonb.ts) does not re-parse.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { schema } from '../src/database/drizzle-schema.js';
import { bootInitDb } from '../src/testing/pglite-init.js';

let db: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let orm: any;

beforeAll(async () => {
  db = await bootInitDb();
  orm = drizzle(db as never);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('jsonb columns round-trip scalars', () => {
  it.each(['true', '1', 'null', '[]', '{"a":1}', 'npm test'])('smoke_test %j reads back as that string', async (smoke) => {
    const [row] = await orm.insert(schema.plugin)
      .values({ orgId: 'org-jsonb', name: `p-${Math.random().toString(36).slice(2, 10)}`, version: '1.0.0', smokeTest: smoke })
      .returning({ id: schema.plugin.id, smokeTest: schema.plugin.smokeTest });
    expect(row.smokeTest).toBe(smoke);
    const [read] = await orm.select({ smokeTest: schema.plugin.smokeTest }).from(schema.plugin).where(eq(schema.plugin.id, row.id));
    expect(read.smokeTest).toBe(smoke);
    // And the stored value IS a jsonb string, not the literal.
    const raw = await db.query<{ t: string }>('SELECT jsonb_typeof(smoke_test) AS t FROM plugins WHERE id = $1', [row.id]);
    expect(raw.rows[0]!.t).toBe('string');
  });

  it('objects and arrays still read back as values', async () => {
    const [row] = await orm.insert(schema.plugin)
      .values({ orgId: 'org-jsonb', name: 'p-obj', version: '1.0.0', smokeTest: { command: 'true' }, keywords: ['a', 'b'] })
      .returning({ smokeTest: schema.plugin.smokeTest, keywords: schema.plugin.keywords });
    expect(row.smokeTest).toEqual({ command: 'true' });
    expect(row.keywords).toEqual(['a', 'b']);
  });

  it('no schema file uses drizzle\'s re-parsing jsonb', () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/database/schema');
    const offenders = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'jsonb.ts').filter((f) => {
      const src = readFileSync(resolve(dir, f), 'utf8');
      const m = src.match(/import\s*\{([^}]*)\}\s*from\s*'drizzle-orm\/pg-core'/g) ?? [];
      return m.some((imp) => /\bjsonb\b/.test(imp));
    });
    expect(offenders).toEqual([]);
  });
});
