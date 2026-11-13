// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sql, type SQL } from 'drizzle-orm';

/** PostgreSQL SQLSTATE for `unique_violation`. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * True when `err` is a PostgreSQL unique-constraint violation. Drizzle may
 * wrap the driver error, so the `cause` chain is checked too.
 */
export function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    if ((cur as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Rows of a raw `execute(sql\`…\`)` result. node-postgres returns
 * `{ rows }`; some drivers (and test fakes) return the bare array.
 */
export function resultRows<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const rows = (res as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** Anything with Drizzle's raw `execute` — the db handle or a transaction. */
export interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

/** Run a raw SQL query and return its rows typed as `T`. */
export async function executeRows<T>(executor: SqlExecutor, query: SQL): Promise<T[]> {
  return resultRows<T>(await executor.execute(query));
}

/**
 * `ANY(<one text[] parameter>)` for a raw `sql` template.
 *
 * Never write `= ANY(${values})`: Drizzle expands a JS array into a parameter
 * LIST, so that renders `ANY(($1, $2))`, a row value Postgres rejects
 * ("op ANY/ALL (array) requires array on right side", or "malformed array
 * literal" for one element). This binds the whole array as a single parameter
 * that node-postgres sends as a real array. An empty list matches nothing.
 */
export function anyText(values: Iterable<string>): SQL {
  return sql`ANY(${sql.param([...values])}::text[])`;
}
