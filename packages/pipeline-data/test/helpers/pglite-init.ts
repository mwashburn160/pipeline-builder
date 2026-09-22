// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot an in-process Postgres (PGlite, WASM) with the REAL shipped
 * `postgres-init.sql` applied, for suites that must observe what the database
 * actually enforces (RLS, FORCE, triggers, constraints) rather than what a
 * string match says the file contains.
 *
 * The init file is a psql script. Its only meta-commands are `\connect`,
 * `\getenv`/`\if`/`\set`/`\unset` (reading credentials from the environment),
 * `\echo` and `\gset`. They are resolved here the way psql would with the
 * variables set: the credential variables become literals, `\gset` terminates
 * its statement, and every other meta-command line is dropped. Everything else
 * runs byte-for-byte.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const INIT_SQL_PATH = resolve(REPO_ROOT, 'deploy/shared/postgres-init.sql');

/** The application login role the init script creates (NOSUPERUSER, NOBYPASSRLS). */
export const APP_ROLE = 'pb_app';

export const SYSTEM_ORG = '000000000000000000000001';

/** The init script with its psql meta-commands resolved (see module doc). */
export function initSqlForPglite(raw = readFileSync(INIT_SQL_PATH, 'utf8')): string {
  return raw
    .replace(/:'pb_app_user'/g, `'${APP_ROLE}'`)
    .replace(/:'pb_app_password'/g, "'test-only-password'")
    // Unset reader password ⇒ the script skips the public-reader role, as in a
    // deployment without the public directory.
    .replace(/:'pb_reader_password'/g, "''")
    .replace(/\s*\\gset\b/g, ';')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
}

/** A fresh database with the init script applied, connected as the superuser. */
export async function bootInitDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(initSqlForPglite());
  return db;
}

/** Tenant scope for {@link asTenant}: the GUCs `withTenantTx` sets. */
export interface TenantScope {
  orgId?: string;
  isSysadmin?: boolean;
}

/**
 * Run `fn` as the APPLICATION role inside a transaction whose RLS GUCs are set
 * exactly as `withTenantTx` sets them, then roll back so tests don't leak rows
 * into each other. Errors from `fn` propagate (after the rollback).
 */
export async function asTenant<T>(db: PGlite, scope: TenantScope, fn: (q: PGlite) => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    await db.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await db.query(
      "SELECT set_config('app.org_id', $1, true), set_config('app.is_sysadmin', $2, true)",
      [scope.orgId ?? '', scope.isSysadmin ? 'true' : 'false'],
    );
    return await fn(db);
  } finally {
    await db.exec('ROLLBACK');
  }
}
