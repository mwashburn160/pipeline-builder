// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { drizzleCount, withTenantTx } from '@pipeline-builder/pipeline-data';
import { sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Shared count-then-page boilerplate for the compliance services' `list`
 * methods. Runs `count(*)` and a `select * … order by … limit … offset` against
 * a single table inside ONE tenant transaction (RLS GUCs applied by
 * `withTenantTx`), so the row page and the total are read from a consistent
 * snapshot. Replaces ~5 hand-rolled copies of the same
 * `[countResult] = select(count)…` + `select().limit().offset()` pair.
 *
 * Rows are returned cast to `Row` (the caller supplies the type and keys the
 * result as it likes) because a generic `PgTable` can't narrow Drizzle's
 * select-all result — the same reason `pipeline-data`'s `drizzleRows`/
 * `drizzleCount` exist. Only for plain single-table lists; joined/projected
 * lists keep their bespoke queries.
 */
export async function paginatedList<Row = Record<string, unknown>>(
  table: PgTable,
  where: SQL | undefined,
  orderBy: SQL,
  limit: number,
  offset: number,
): Promise<{ rows: Row[]; total: number }> {
  return withTenantTx(async (tx) => {
    const [countResult] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(table)
      .where(where)
      .then((r: unknown[]) => drizzleCount(r));

    const rows = await tx
      .select()
      .from(table)
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    return { rows: rows as unknown as Row[], total: countResult?.count ?? 0 };
  });
}
