// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The REAL tenant transaction, bound to an in-process PGlite.
 *
 * `bootTenantDb()` boots the shipped `postgres-init.sql` (see
 * {@link bootInitDb}), wraps it in Drizzle's PGlite driver and installs that as
 * the package's shared `db`. From then on `withTenantTx`, `withTenantTxRead`
 * (primary path — there is no replica), CrudService and every service built on
 * them run their production code, unmodified, against a database that enforces
 * the real RLS policies, FORCE flags, triggers and constraints.
 *
 * WHY THE SESSION RUNS AS `pb_app`. PGlite connects as a superuser, and
 * superusers bypass row-level security entirely — a suite that stayed on that
 * role would pass whether or not a policy existed. So the session drops to the
 * application login role (NOSUPERUSER, NOBYPASSRLS) once the schema is in, which
 * is exactly the role production queries run as. Seeding and cleanup that must
 * see every org go through {@link TenantTestDb.asOwner}.
 *
 * Usage:
 *
 *   const tdb = await bootTenantDb();
 *   await tdb.asOwner((q) => q.query('INSERT INTO messages …'));
 *   const n = await asTenantContext({ orgId: 'org-a' }, () => messageService.getUnreadCount('org-a'));
 *   await tdb.close();
 *
 * PGlite is ONE connection: a transaction holds it exclusively, so a test must
 * not issue a raw `pglite.query` from inside a callback that is itself running
 * in a `withTenantTx` — it would wait on the transaction it is inside.
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { APP_ROLE, bootInitDb } from './pglite-init.js';
import { schema } from '../database/drizzle-schema.js';
import { setDbInstanceForTesting } from '../database/postgres-connection.js';
import { runWithTenantContext, type TenantContext } from '../database/tenancy.js';

/** A PGlite database installed as the package's shared `db`. */
export interface TenantTestDb {
  /** The raw PGlite handle (session role: `pb_app`). */
  pglite: PGlite;
  /** The Drizzle instance installed as `db` — the same object `withTenantTx` uses. */
  db: PgliteDatabase<typeof schema>;
  /**
   * Run `fn` as the bootstrap SUPERUSER (RLS bypassed) — for seeding fixtures
   * and resetting tables across orgs. The session returns to `pb_app` afterwards,
   * even when `fn` throws.
   */
  asOwner<T>(fn: (q: PGlite) => Promise<T>): Promise<T>;
  /** Uninstall from `db` and shut PGlite down. */
  close(): Promise<void>;
}

/**
 * Boot a fresh init-script database and install it as the package's `db`.
 * Pass an already-booted PGlite (from {@link bootInitDb}) to reuse one.
 */
export async function bootTenantDb(existing?: PGlite): Promise<TenantTestDb> {
  const pglite = existing ?? await bootInitDb();
  await pglite.exec(`SET ROLE ${APP_ROLE}`);
  const db = drizzle(pglite, { schema });
  setDbInstanceForTesting(db);

  return {
    pglite,
    db,
    async asOwner<T>(fn: (q: PGlite) => Promise<T>): Promise<T> {
      await pglite.exec('RESET ROLE');
      try {
        return await fn(pglite);
      } finally {
        await pglite.exec(`SET ROLE ${APP_ROLE}`);
      }
    },
    async close(): Promise<void> {
      setDbInstanceForTesting(null);
      await pglite.close();
    },
  };
}

/**
 * Run `fn` inside a tenant scope — the same AsyncLocalStorage scope the request
 * middleware establishes, so every `withTenantTx` underneath sets the RLS GUCs
 * from it. `isSuperAdmin` defaults to false (an ordinary tenant).
 */
export function asTenantContext<T>(ctx: Partial<TenantContext>, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuperAdmin: false, ...ctx }, fn);
}
