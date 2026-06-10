// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant-context plumbing for Postgres row-level security.
 *
 * Background: postgres-init.sql installs RLS policies on every user-data
 * table that consult two session GUCs — `app.org_id` and `app.is_sysadmin`.
 * Today the tables are in owner-bypass mode (the connection user owns them,
 * Postgres lets owners skip RLS), so the policies don't actually enforce.
 * Once we flip a table to `FORCE ROW LEVEL SECURITY`, every query against
 * it must run inside a transaction that has SET LOCAL'd both GUCs — or it
 * returns zero rows for non-sysadmins (and may fail to write for any caller).
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
 * Migration order (see docs/plans/f-1-0-rls-enforcement.md):
 *   - First adopters: newly-written services (dashboard, alert-destination)
 *     where the change is mechanical.
 *   - Then high-write services (plugin, pipeline). Soak each one before
 *     flipping the underlying table to FORCE.
 *   - admin_audit_log uses a sysadmin-only policy — sysadmin paths must
 *     also set `app.is_sysadmin = 'true'` or they'll lose access to it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { db } from './postgres-connection.js';

const logger = createLogger('tenant-context');

/**
 * Behavior when `withTenantTx` is invoked outside any `runWithTenantContext`
 * scope. Defaults to 'warn' so existing code paths that haven't been audited
 * keep working but surface in logs. Set RLS_CONTEXT_MODE=strict to flip
 * production into fail-fast — recommended once the codebase is fully audited.
 *
 * 'silent' is kept for tests and scripts that intentionally enter the DB
 * without context (e.g. integration test setup that runs as the connection
 * owner before any tenant is provisioned).
 */
type ContextMode = 'silent' | 'warn' | 'strict';
function getContextMode(): ContextMode {
  const raw = (process.env.RLS_CONTEXT_MODE || 'warn').toLowerCase();
  return raw === 'silent' || raw === 'strict' ? raw : 'warn';
}

export interface TenantContext {
  /** Caller's org. Undefined for un-authenticated / system jobs. */
  orgId?: string;
  /** True when the caller is a sysadmin (system-org admin). Bypasses RLS
   *  policies via the sysadmin-bypass branch in `current_is_sysadmin()`. */
  isSuperAdmin: boolean;
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
 * Assert that the current code is running inside a tenant scope. Callers
 * that legitimately need to refuse to operate without one (e.g. handlers
 * that touch FORCE'd RLS tables) can use this instead of relying on the
 * downstream "permission denied" error to surface the bug.
 */
export function requireTenantContext(): TenantContext {
  const ctx = tenantContext.getStore();
  if (!ctx) {
    throw new Error(
      'requireTenantContext: no tenant scope active. Wrap your handler/worker in '
      + 'runWithTenantContext({ orgId, isSuperAdmin }, ...) before any DB call.',
    );
  }
  return ctx;
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

  return db.transaction(async (tx) => {
    // SET LOCAL via set_config() so the values are transaction-scoped (auto-
    // released on COMMIT/ROLLBACK). The driver binds the values as parameters,
    // so a hostile org_id can't break out of the GUC syntax.
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(sql`SELECT set_config('app.is_sysadmin', ${isSuperAdmin}, true)`);
    return fn(tx);
  });
}
