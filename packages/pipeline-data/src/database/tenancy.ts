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
import { createLogger, emitCounter, envInt } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { db } from './postgres-connection.js';
import { getReadDb, getReadPool } from './read-connection.js';
import { lagVerdict, maybeSampleLag, type LagVerdict } from './read-lag.js';

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
  /**
   * Set once this request has opened a PRIMARY transaction, i.e. may have
   * written. Subsequent `withTenantTxRead` calls in the same request then go to
   * the primary too, so a handler cannot read its own write off a replica that
   * has not replayed it yet.
   *
   * Deliberately set by `withTenantTx` rather than by write call sites: that
   * path is the one that can write, it needs no per-call-site discipline, and
   * being wrong in this direction only costs a replica hit. Mutated in place on
   * the AsyncLocalStorage store — the store is per-request, so this cannot leak
   * between requests.
   *
   * SCOPE: this flag covers reads AFTER a write IN THE SAME REQUEST. The
   * next-request case (POST, then a page reload issuing GET) needs shared state
   * and is handled by api-server's `write-pin.ts`, which remembers in Redis
   * that an org wrote recently and PRE-SETS this same flag on the next
   * request's context — one mechanism and one code path rather than two. It
   * fails closed (no Redis, or an unreachable one, routes reads to the primary)
   * and short-circuits entirely when no read replica is configured.
   */
  mayHaveWritten?: boolean;
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
  /**
   * INTERNAL. Whether this transaction should mark the request as possibly
   * having written. Always true for a real caller; only withTenantTxRead's
   * primary-fallback path passes false, because a read that lands on the
   * primary has not written. See the comment at the assignment below.
   */
  markWritten = true,
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

  // This transaction runs on the PRIMARY and may write, so any later read in
  // this request must stay on the primary too. Set before the transaction opens
  // rather than after it commits: a read issued concurrently from the same
  // handler would otherwise race the flag.
  //
  // `markWritten: false` is passed ONLY by withTenantTxRead's fallback path,
  // and it is not an optimisation — without it the feature defeats itself. That
  // path runs on the primary, so it would set this flag, which api-server's
  // middleware reads after the response to set the Redis write pin. A purely
  // READ-ONLY request would therefore pin its whole org to the primary for the
  // pin TTL, every time, and since reads fall back whenever no replica is
  // configured (the shipping default) every org would be permanently pinned.
  // The flag means "this request may have WRITTEN", not "this request touched
  // the primary", and the difference is the whole read-offload benefit.
  if (ctx && markWritten) ctx.mayHaveWritten = true;

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

/**
 * Why a read was or was not sent to the replica. Returned by
 * {@link chooseReadTarget} so the decision is inspectable — and testable
 * without a replica, which matters because the test substrate (PGlite) has no
 * replication at all.
 */
export type ReadTargetReason =
  /** No replica configured, or DB_READ_ENABLED=false. */
  | 'no-replica'
  /** This request already opened a primary transaction and may have written. */
  | 'may-have-written'
  /**
   * No tenant context. A caller outside `runWithTenantContext` has no org to
   * scope RLS by and no watermark to compare, so it goes to the primary — where
   * `withTenantTx`'s RLS_CONTEXT_MODE guard logs or throws. Routed to a replica
   * instead, the same call would set `app.org_id = ''` with no diagnostic at all.
   */
  | 'no-context'
  /**
   * A replica exists but its replay lag is beyond `DB_READ_MAX_LAG_SECONDS`,
   * or is UNKNOWN (no sample yet, the sample failed, or the cached sample has
   * gone stale). Unknown and lagging are the same decision on purpose: the
   * circuit fails closed.
   */
  | 'replica-lagging'
  /** Routed to the replica. */
  | 'replica';

export interface ReadTarget {
  useReplica: boolean;
  reason: ReadTargetReason;
}

/**
 * Decide where a read-only transaction should run.
 *
 * Pure and side-effect free on purpose: this is the whole of the routing
 * policy, and it is the part worth testing. Replication itself cannot be
 * reproduced locally, so the testable unit is the DECISION, not the lag.
 *
 * The bias is deliberate: anything uncertain resolves to the primary. A read
 * served by the primary is merely less efficient; a read served by a stale
 * replica is a user-visible bug nobody can reproduce.
 */
/** Everything about the replica that is not request-specific. */
export interface ReadReplicaHealth {
  /** A replica pool exists AND `DB_READ_ENABLED` is not false. */
  available: boolean;
  /** The lag circuit's verdict. `unknown` is treated exactly like `lagging`. */
  lag: LagVerdict;
}

/**
 * Where a read goes, and why.
 *
 * SYSTEM gates are checked before REQUEST gates, which matters only for the
 * explanation — but the explanation is what an operator reads when asking why
 * the replica is idle, and "my request wrote" is a far less useful answer than
 * "the standby is 40 seconds behind".
 */
export function chooseReadTarget(ctx: TenantContext | undefined, health: ReadReplicaHealth): ReadTarget {
  if (!health.available) return { useReplica: false, reason: 'no-replica' };
  if (health.lag !== 'ok') return { useReplica: false, reason: 'replica-lagging' };
  if (!ctx) return { useReplica: false, reason: 'no-context' };
  if (ctx.mayHaveWritten) return { useReplica: false, reason: 'may-have-written' };
  return { useReplica: true, reason: 'replica' };
}

/**
 * Open a READ-ONLY transaction with the same RLS GUCs `withTenantTx` sets,
 * routed to the replica when {@link chooseReadTarget} allows it.
 *
 * `SET TRANSACTION READ ONLY` is the guardrail, not decoration. Several queries
 * in this codebase look like reads at the call site and are not —
 * `SELECT … FOR UPDATE` in crud-service's setDefault, `pg_advisory_xact_lock`
 * in pipeline-service and compliance's subscription-service. Routed to a
 * standby those fail anyway; declaring the transaction read-only makes them
 * fail HERE, with a clear message, including on the primary where they would
 * otherwise succeed and quietly acquire a lock the caller did not intend.
 *
 * Falls back to the primary transparently, so a caller never has to ask
 * whether a replica exists.
 */
export async function withTenantTxRead<T>(
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  const ctx = tenantContext.getStore();
  const readDb = getReadDb();
  const readPool = getReadPool();

  // Keep the lag sample warm. Fire-and-forget by design: it is debounced to
  // DB_READ_LAG_SAMPLE_MS, never throws, and must not add a round-trip to this
  // read. The first read of a process therefore routes to the primary (no
  // sample yet) and warms the circuit for the ones after it.
  if (readPool) void maybeSampleLag(readPool);

  const target = chooseReadTarget(ctx, { available: readDb !== null, lag: lagVerdict() });
  emitCounter('postgres_read_routed_total', { target: target.useReplica ? 'replica' : 'primary', reason: target.reason });

  if (!target.useReplica) {
    // Primary path: identical semantics to withTenantTx, plus the read-only
    // declaration so an accidental write is caught on every target — including
    // the ones that will never have a replica.
    return withTenantTx(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return fn(tx);
    }, /* markWritten */ false);
  }

  // Non-null by construction: chooseReadTarget only returns useReplica for a
  // ctx that exists. Read the GUCs off it directly rather than defaulting to
  // '' — a default here would silently re-open the hole that 'no-context'
  // closes, because an empty app.org_id is a VALID-looking RLS scope.
  const { orgId } = ctx!;
  const isSuperAdmin = ctx!.isSuperAdmin ? 'true' : 'false';
  const statementTimeoutMs = getStatementTimeoutMs();

  return readDb!.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
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
