// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one way an owning service tears its share of a deleted org down:
 * {@link purgeOrgData} over its slice of `ORG_DATA_OWNERSHIP`
 * (`./org-data-ownership.ts`). Every owning service's cascade-outbox endpoint
 * calls it with its own owner key; platform calls it only for `platform`.
 */

import { eq, getTableColumns, sql } from 'drizzle-orm';
import { ORG_DATA_OWNERSHIP, type OrgDataOwner } from './org-data-ownership.js';
import { affectedRowCount } from '../database/pg-result.js';
import { runWithTenantContext, withTenantTx } from '../database/tenancy.js';

/** One table's outcome: a row count, or the error that stopped it. */
export interface OrgTablePurgeOutcome {
  ok: boolean;
  rowCount?: number;
  error?: string;
  /** The table does not exist in this database (created before it shipped): nothing to purge. */
  absent?: true;
}

/** The result of one owner's purge of one org. */
export interface OrgDataPurgeResult {
  orgId: string;
  owner: OrgDataOwner;
  /** Per-table outcome, keyed by table name. */
  tables: Record<string, OrgTablePurgeOutcome>;
  /** Names of the tables that failed. Non-empty ⇒ the caller must NOT ack. */
  failed: string[];
  /**
   * Names of the tables this database does not have — it was created before
   * they shipped (postgres-init.sql runs on a NEW install only, never as an
   * upgrade). Skipped, not failed: an absent table holds no rows to purge.
   */
  absent: string[];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Tables known to exist, per process. Only PRESENT tables are cached: a table
 * missing now may be created later (a fresh install of a newer schema), so an
 * absent one is re-checked on the next purge.
 */
const presentTables = new Set<string>();

/**
 * Whether `public.<name>` exists (`to_regclass`, no error for a missing
 * relation). Call inside a tenant scope. A database created before a table
 * shipped never gets it (postgres-init.sql runs on new installs only).
 */
export async function tableExists(name: string): Promise<boolean> {
  if (presentTables.has(name)) return true;
  const res = await withTenantTx((tx) => tx.execute(sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`));
  const rows = (res as unknown as { rows?: Array<{ present?: unknown }> }).rows ?? (res as unknown as Array<{ present?: unknown }>);
  const present = Array.isArray(rows) && (rows[0]?.present === true || rows[0]?.present === 't');
  if (present) presentTables.add(name);
  return present;
}

/** Forget the per-process existence cache (tests). */
export function resetPurgeTableCacheForTesting(): void {
  presentTables.clear();
}

/**
 * Tombstone (`soft`) or remove (`hard`) every row `owner` holds for `orgId`.
 *
 * IDEMPOTENT: the soft UPDATE only matches rows not already tombstoned and the
 * hard DELETE matches nothing on a second run, so a redelivered outbox leg is
 * a no-op that still answers success. That is what lets the caller ack on a
 * plain 2xx.
 *
 * Runs under a SYSADMIN tenant context (RLS is FORCE'd and the org being
 * purged is never the caller's), one transaction per table so one table's
 * failure doesn't roll back the rest. Never throws for a table: failures are
 * named in `failed`, and the endpoint answers non-2xx so the leg is retried.
 */
export async function purgeOrgData(
  owner: OrgDataOwner,
  orgId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<OrgDataPurgeResult> {
  const slice = ORG_DATA_OWNERSHIP[owner];
  const result: OrgDataPurgeResult = { orgId, owner, tables: {}, failed: [], absent: [] };
  if (!orgId) throw new Error('purgeOrgData: orgId is required');

  await runWithTenantContext({ isSuperAdmin: true }, async () => {
    /** True (and recorded) when the table is missing from this database. */
    const skipAbsent = async (name: string): Promise<boolean> => {
      if (await tableExists(name)) return false;
      result.tables[name] = { ok: true, rowCount: 0, absent: true };
      result.absent.push(name);
      return true;
    };
    for (const { table, name } of slice.soft) {
      try {
        if (await skipAbsent(name)) continue;
        // `purge_after = now` ALONGSIDE `deleted_at`: the owner's retention sweep
        // is keyed on `deleted_at IS NOT NULL AND purge_after < now`, so a NULL
        // `purge_after` would leave the rows in Postgres forever. `is_active =
        // false` too where the table has it: list reads filter on `is_active`
        // (not `deleted_at`), so a row tombstoned without it stays listed until
        // the sweep — and a CrudService tombstone is `is_active = false` AND
        // `deleted_at IS NOT NULL`.
        const set = { deletedAt: now, purgeAfter: now, ...('isActive' in getTableColumns(table) ? { isActive: false } : {}) };
        const res = await withTenantTx((tx) => tx.update(table)
          .set(set as never)
          .where(sql`${(table as unknown as { orgId: unknown }).orgId} = ${orgId} AND deleted_at IS NULL`));
        result.tables[name] = { ok: true, rowCount: affectedRowCount(res) };
      } catch (err) {
        result.tables[name] = { ok: false, error: message(err) };
        result.failed.push(name);
      }
    }
    for (const { table, name } of slice.hard) {
      try {
        if (await skipAbsent(name)) continue;
        const res = await withTenantTx((tx) => tx.delete(table)
          .where(eq((table as unknown as { orgId: unknown }).orgId as never, orgId)));
        result.tables[name] = { ok: true, rowCount: affectedRowCount(res) };
      } catch (err) {
        result.tables[name] = { ok: false, error: message(err) };
        result.failed.push(name);
      }
    }
  });
  return result;
}

/** Row counts only (no error strings) — what an endpoint returns and audits. */
export function purgeRowCounts(result: OrgDataPurgeResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, r] of Object.entries(result.tables)) if (r.ok) out[name] = r.rowCount ?? 0;
  return out;
}
