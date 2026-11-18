// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one way an owning service tears its share of a deleted org down:
 * {@link purgeOrgData} over its slice of `ORG_DATA_OWNERSHIP`
 * (`./org-data-ownership.ts`). Every owning service's cascade-outbox endpoint
 * calls it with its own owner key; platform calls it only for `platform`.
 */

import { eq, sql } from 'drizzle-orm';
import { ORG_DATA_OWNERSHIP, type OrgDataOwner } from './org-data-ownership.js';
import { runWithTenantContext, withTenantTx } from '../database/tenancy.js';

/** One table's outcome: a row count, or the error that stopped it. */
export interface OrgTablePurgeOutcome {
  ok: boolean;
  rowCount?: number;
  error?: string;
}

/** The result of one owner's purge of one org. */
export interface OrgDataPurgeResult {
  orgId: string;
  owner: OrgDataOwner;
  /** Per-table outcome, keyed by table name. */
  tables: Record<string, OrgTablePurgeOutcome>;
  /** Names of the tables that failed. Non-empty ⇒ the caller must NOT ack. */
  failed: string[];
}

/** node-postgres reports `rowCount`; PGlite (the test substrate) `affectedRows`. */
function affected(res: unknown): number {
  const r = res as { rowCount?: number | null; affectedRows?: number };
  return r.rowCount ?? r.affectedRows ?? 0;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
  const result: OrgDataPurgeResult = { orgId, owner, tables: {}, failed: [] };
  if (!orgId) throw new Error('purgeOrgData: orgId is required');

  await runWithTenantContext({ isSuperAdmin: true }, async () => {
    for (const { table, name } of slice.soft) {
      try {
        // `purge_after = now` ALONGSIDE `deleted_at`: the owner's retention sweep
        // is keyed on `deleted_at IS NOT NULL AND purge_after < now`, so a NULL
        // `purge_after` would leave the rows in Postgres forever.
        const res = await withTenantTx((tx) => tx.update(table)
          .set({ deletedAt: now, purgeAfter: now } as never)
          .where(sql`${(table as unknown as { orgId: unknown }).orgId} = ${orgId} AND deleted_at IS NULL`));
        result.tables[name] = { ok: true, rowCount: affected(res) };
      } catch (err) {
        result.tables[name] = { ok: false, error: message(err) };
        result.failed.push(name);
      }
    }
    for (const { table, name } of slice.hard) {
      try {
        const res = await withTenantTx((tx) => tx.delete(table)
          .where(eq((table as unknown as { orgId: unknown }).orgId as never, orgId)));
        result.tables[name] = { ok: true, rowCount: affected(res) };
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
