// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant-context plumbing for Postgres row-level security.
 *
 * Background: postgres-init.sql installs RLS policies on every user-data
 * table that consult two session GUCs — `app.org_id` and `app.is_sysadmin`.
 * Every tenant table is `FORCE ROW LEVEL SECURITY`, so the policies enforce
 * even for the (owning) connection user — a query against one must run inside a
 * transaction that has SET LOCAL'd both GUCs or it returns zero rows for
 * non-sysadmins (and may fail to write for any caller). The cross-org plugin
 * ecosystem catalog tables carry a permissive app-role policy instead.
 *
 * This module is the seam.
 *
 *   1. `tenantContext` (AsyncLocalStorage) carries `{orgId, isSuperAdmin}`
 *      down the call chain without prop-drilling. Set once at the request
 *      boundary; readable from anywhere.
 *
 *   2. `withTenantTx(fn)` opens a transaction, SET LOCAL's both GUCs from
 *      the surrounding context, then invokes `fn(tx)`. Services migrate one
 *      at a time by wrapping their existing drizzle calls in this helper —
 *      `db.select().from(...)` becomes `withTenantTx(tx => tx.select().from(...))`.
 *
 *   3. `runWithTenantContext(ctx, fn)` is the Express-middleware-side
 *      bookend that establishes the AsyncLocalStorage scope for the request.
 *
 * Migration order:
 *   - First adopters: newly-written services (dashboard, alert-destination)
 *     where the change is mechanical.
 *   - Then high-write services (plugin, pipeline). Soak each one before
 *     flipping the underlying table to FORCE.
 *   - admin_audit_log uses a sysadmin-only policy — sysadmin paths must
 *     also set `app.is_sysadmin = 'true'` or they'll lose access to it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger, envInt } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { db } from './postgres-connection.js';

const logger = createLogger('tenant-context');

/**
 * Behavior when `withTenantTx` is invoked outside any `runWithTenantContext`
 * scope. The effective default is fail-fast ('strict') in production so a
 * missing tenant scope surfaces at the bad call site instead of silently
 * running with empty RLS GUCs; outside production it defaults to 'warn' so
 * un-audited dev/test paths keep working but log an actionable trace. An
 * explicit RLS_CONTEXT_MODE env override always wins.
 *
 * 'silent' is kept for tests and scripts that intentionally enter the DB
 * without context (e.g. integration test setup that runs as the connection
 * owner before any tenant is provisioned).
 */
type ContextMode = 'silent' | 'warn' | 'strict';
function getContextMode(): ContextMode {
  const raw = process.env.RLS_CONTEXT_MODE?.toLowerCase();
  if (raw === 'silent' || raw === 'warn' || raw === 'strict') return raw;
  // No explicit override: fail-fast in production, warn everywhere else.
  return process.env.NODE_ENV === 'production' ? 'strict' : 'warn';
}

/**
 * Per-statement server-side timeout (ms) applied INSIDE every `withTenantTx`
 * transaction, next to the RLS GUCs. `withTenantTx` is the real query path for
 * all RLS/CRUD reads and writes, so this is where the DB-side guard belongs (the
 * old `Connection.transaction` wrapper that set it is dead — see
 * postgres-connection.ts). Bounds a runaway query so it can't hold a pooled
 * connection open indefinitely. Env-configurable via `DB_STATEMENT_TIMEOUT_MS`
 * (default 30s); set to `0` to disable the timeout.
 */
function getStatementTimeoutMs(): number {
  const ms = envInt('DB_STATEMENT_TIMEOUT_MS', 30_000);
  return ms >= 0 ? ms : 30_000;
}

export interface TenantContext {
  /** Caller's org. Undefined for un-authenticated / system jobs. */
  orgId?: string;
  /** Caller's user id. Not used for RLS — Postgres policies are org-grained,
   *  with no per-user session GUC — but carried so app-layer predicates with a
   *  PER-USER rung (pipeline templates' `private` visibility) can resolve "who
   *  is asking" on paths that have nowhere to pass it, notably CrudService's
   *  `writeConditions`. Absent for system jobs, which is the fail-closed case:
   *  no viewer ⇒ no private rows. */
  userId?: string;
  /** True when the caller is a sysadmin (system-org admin). Bypasses RLS
   *  policies via the sysadmin-bypass branch in `current_is_sysadmin()`. */
  isSuperAdmin: boolean;
  /** Org → team hierarchy: the caller's active-org parent (present only when the
   *  active org is a team). Not used for RLS; carried so downstream side-effects
   *  (e.g. entity-event compliance eval) can honor parent `propagateToChildren`
   *  rules without a request in scope. */
  parentOrgId?: string;
}

/**
 * Per-request tenant context. Populated by Express middleware once the JWT
 * is validated; consumed by `withTenantTx` and any helper that needs to
 * know "who is the caller" without re-deriving from the request object.
 */
export const tenantContext = new AsyncLocalStorage<TenantContext>();

/**
 * Run `fn` inside the given tenant scope. The AsyncLocalStorage scope
 * survives across async boundaries (Promises, setTimeout, etc.), so any
 * `withTenantTx` call inside `fn` — directly or through any depth of
 * async helpers — picks up `ctx`.
 *
 * Wrap `next()` from an Express middleware to establish per-request scope:
 *
 *     app.use((req, res, next) => {
 *       runWithTenantContext({ orgId, isSuperAdmin }, () => next());
 *     });
 */
export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return tenantContext.run(ctx, fn);
}

/** Read the current tenant context. Returns undefined outside an
 *  `runWithTenantContext` scope (e.g. background workers, migrations). */
export function getTenantContext(): TenantContext | undefined {
  return tenantContext.getStore();
}

/**
 * Open a transaction with RLS GUCs SET LOCAL from the current
 * AsyncLocalStorage tenant context, then invoke `fn(tx)`.
 *
 * - When called outside a tenant scope (e.g. from a background job that
 *   doesn't have a caller identity), the transaction is opened with both
 *   GUCs cleared — RLS policies will return zero rows on FORCE'd tables.
 *   Callers that need a sysadmin-equivalent scope should wrap themselves in
 *   `runWithTenantContext({ isSuperAdmin: true }, …)` explicitly.
 *
 * - Uses `set_config(key, value, true)` (the boolean = `is_local`, i.e.
 *   transaction-scoped). Equivalent to `SET LOCAL` but takes the value as
 *   a parameter, which is what we want — Drizzle's `sql` template binds the
 *   value safely so an attacker-controlled `orgId` can't escape the quoting.
 *
 * - Returns whatever `fn` returns; throws whatever `fn` throws (Drizzle
 *   handles the COMMIT/ROLLBACK for us).
 */
export async function withTenantTx<T>(
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  const ctx = tenantContext.getStore();

  if (!ctx) {
    // Surface the bug instead of silently SET'ing empty GUCs. The default
    // mode ('warn') logs an actionable trace so the bad call site is easy
    // to find; production deployments that have finished the audit can set
    // RLS_CONTEXT_MODE=strict to fail-fast at the call site (better stack
    // trace than the Postgres "permission denied" that would otherwise
    // surface from FORCE'd RLS).
    const mode = getContextMode();
    if (mode === 'strict') {
      throw new Error(
        'withTenantTx called outside a tenant scope. Wrap your handler/worker '
        + 'in runWithTenantContext({ orgId, isSuperAdmin }, ...) before invoking '
        + 'any service that touches RLS-enforced tables.',
      );
    }
    if (mode === 'warn') {
      // Include a synthetic stack so the offending call site is in the log.
      logger.warn('withTenantTx called outside a tenant scope; RLS GUCs will be empty', {
        stack: new Error('tenant-context missing').stack,
      });
    }
  }

  const orgId = ctx?.orgId ?? '';
  const isSuperAdmin = ctx?.isSuperAdmin ? 'true' : 'false';

  const statementTimeoutMs = getStatementTimeoutMs();

  return db.transaction(async (tx) => {
    // Set every transaction-scoped GUC in a SINGLE round-trip. `set_config()`
    // returns its value, so multiple calls compose in one SELECT rather than a
    // round-trip per GUC — each a network hop that taxes the shared PgBouncer
    // pool on the hot path. `true`
    // = is_local (SET LOCAL semantics: auto-released on COMMIT/ROLLBACK). The
    // driver binds the values as parameters, so a hostile org_id can't break out
    // of the GUC syntax.
    //
    // The statement_timeout GUC bounds a runaway query so it can't hold a pooled
    // connection open indefinitely (`SET LOCAL statement_timeout = $1` is rejected
    // by Postgres, hence set_config with a bound ms value). Included in the same
    // statement when enabled (>0), dropped entirely when disabled (0).
    if (statementTimeoutMs > 0) {
      await tx.execute(
        sql`SELECT set_config('app.org_id', ${orgId}, true), set_config('app.is_sysadmin', ${isSuperAdmin}, true), set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`,
      );
    } else {
      await tx.execute(
        sql`SELECT set_config('app.org_id', ${orgId}, true), set_config('app.is_sysadmin', ${isSuperAdmin}, true)`,
      );
    }
    return fn(tx);
  });
}
