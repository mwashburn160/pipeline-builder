// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Keyset (cursor) pagination primitives for `CrudService.findPaginated`.
 *
 * Pure functions over a Drizzle column — no table, no tenant context, no I/O —
 * which is why they live outside the CRUD base class: the cursor encoding and
 * its "is this castable / strictly after" rules are the fiddly, test-worthy
 * part of paging and are easier to reason about on their own.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';

/** Projection alias carrying the sort column's exact DB text for the next cursor. */
export const CURSOR_SORT_KEY = '__cursorSortKey';

/**
 * Opaque keyset cursor: the last row's sort value as Postgres TEXT (full
 * precision — a JS `Date` would truncate `timestamptz` microseconds to ms, so
 * `created_at > '<ms>'` re-returns or skips rows in the same millisecond) plus
 * its `id` as the tie-breaker.
 */
export function encodeCursor(sortText: string | null, id: string): string {
  return Buffer.from(JSON.stringify([sortText, id]), 'utf8').toString('base64url');
}

/** Decode a cursor produced by {@link encodeCursor}; `null` when malformed. */
export function decodeCursor(cursor: string): { sortText: string | null; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) && parsed.length === 2
      && (parsed[0] === null || typeof parsed[0] === 'string')
      && typeof parsed[1] === 'string' && parsed[1].length > 0
    ) {
      return { sortText: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres `timestamp[tz]::text` / `date::text` (also accepts ISO-8601). */
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/**
 * Whether `text` can be cast to `column`'s type. A decoded cursor is still
 * client input: a value Postgres can't cast (a non-UUID id, a garbage
 * timestamp) fails the whole query with a 500. Column types this doesn't know
 * (text, varchar, …) accept any string.
 */
export function isCastableTo(column: AnyColumn, text: string): boolean {
  const { columnType, dataType } = column;
  const enumValues = (column as { enumValues?: readonly string[] }).enumValues;
  if (columnType === 'PgUUID') return UUID_TEXT.test(text);
  if ((columnType === 'PgEnumColumn' || columnType === 'PgEnumObjectColumn') && enumValues?.length) return enumValues.includes(text);
  if (dataType === 'date' || columnType === 'PgTimestampString' || columnType === 'PgDateString') return TIMESTAMP_TEXT.test(text);
  if (dataType === 'boolean') return text === 'true' || text === 'false';
  if (dataType === 'number' || dataType === 'bigint') return NUMERIC_TEXT.test(text);
  return true;
}

/**
 * Keyset predicate "strictly after (sortText, id)" for `ORDER BY sort <dir>, id <dir>`
 * under Postgres' default null placement (ASC → NULLS LAST, DESC → NULLS FIRST).
 * The text value is bound as a parameter compared against the column, so Postgres
 * casts it back to the column's type at full precision.
 */
export function keysetAfter(
  sortColumn: AnyColumn,
  idColumn: AnyColumn,
  sortOrder: 'asc' | 'desc',
  sortText: string | null,
  id: string,
): SQL {
  if (sortColumn === idColumn) {
    return sortOrder === 'desc' ? sql`${idColumn} < ${id}` : sql`${idColumn} > ${id}`;
  }
  if (sortOrder === 'asc') {
    return sortText === null
      ? sql`(${sortColumn} IS NULL AND ${idColumn} > ${id})`
      : sql`(${sortColumn} > ${sortText} OR (${sortColumn} = ${sortText} AND ${idColumn} > ${id}) OR ${sortColumn} IS NULL)`;
  }
  return sortText === null
    ? sql`(${sortColumn} IS NOT NULL OR (${sortColumn} IS NULL AND ${idColumn} < ${id}))`
    : sql`(${sortColumn} < ${sortText} OR (${sortColumn} = ${sortText} AND ${idColumn} < ${id}))`;
}
