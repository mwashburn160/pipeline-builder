// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-process Postgres (PGlite) with the REAL shipped `postgres-init.sql`
 * applied, plus a `withTenantTx` that runs on it exactly as pipeline-data's
 * does: one transaction, as the application role (`pb_app`, RLS enforced),
 * with the tenant GUCs set from the current tenant context.
 *
 * The same harness as pipeline-data's `test/helpers/pglite-init.ts`; PGlite is
 * that package's dev dependency, so it is resolved from there rather than
 * added to this one. Used by suites whose behaviour IS SQL — row locks, FK
 * RESTRICT, RLS — where a mocked transaction proves nothing.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fromPipelineData = createRequire(resolve(REPO_ROOT, 'packages/pipeline-data/package.json'));

/** The docker target's init script with its psql meta-commands resolved (see pipeline-data's harness). */
function initSql(): string {
  return readFileSync(resolve(REPO_ROOT, 'deploy/local/docker/postgres-init.sql'), 'utf8')
    .replace(/:'pb_app_user'/g, "'pb_app'")
    .replace(/:'pb_app_password'/g, "'test-only-password'")
    .replace(/:'pb_reader_password'/g, "''")
    .replace(/:'pb_repl_user'/g, "''")
    .replace(/:'pb_repl_password'/g, "''")
    .replace(/\s*\\gset\b/g, ';')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
}

/** The raw PGlite handle (superuser — bypasses RLS; for seeding and inspecting). */
export interface RawDb {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface TestDb {
  raw: RawDb;
  /** Drop-in for pipeline-data's `withTenantTx`, bound to this database. */
  withTenantTx<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/** Boot a fresh database. `tenant()` reads the current tenant context (pipeline-data's `getTenantContext`). */
export async function bootTestDb(tenant: () => { orgId?: string; isSuperAdmin?: boolean } | undefined): Promise<TestDb> {
  const { PGlite } = await import(pathToFileURL(fromPipelineData.resolve('@electric-sql/pglite')).href);
  const { pg_trgm } = await import(pathToFileURL(fromPipelineData.resolve('@electric-sql/pglite/contrib/pg_trgm')).href);
  const { drizzle } = await import('drizzle-orm/pglite');
  const { sql } = await import('drizzle-orm');
  const raw = new PGlite({ extensions: { pg_trgm } }) as RawDb;
  await raw.exec(initSql());
  const db = drizzle(raw as never);
  return {
    raw,
    withTenantTx: (fn) => {
      const ctx = tenant();
      return db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE pb_app`);
        await tx.execute(sql`SELECT set_config('app.org_id', ${ctx?.orgId ?? ''}, true), set_config('app.is_sysadmin', ${ctx?.isSuperAdmin ? 'true' : 'false'}, true)`);
        return fn(tx);
      });
    },
  };
}
