// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Date coercions for the JSON boundary. */

/**
 * A nullable timestamp as an ISO-8601 string, or `null` when there is no date.
 *
 * The shape every API response needs at the DB→JSON boundary: Postgres and
 * Mongo hand back `Date | null`, the wire wants `string | null`, and a bare
 * `row.x?.toISOString() ?? null` breaks the moment the driver returns a string
 * instead (Mongo aggregation output, a `::text` cast, a cached row rehydrated
 * from JSON). Normalizing through `new Date(d)` handles both.
 *
 * Falsy in, `null` out — which folds the epoch (`new Date(0)`) to `null` too.
 * That is intentional and matches every hand-rolled copy this replaces: a
 * zero timestamp in this codebase means "unset", never 1970.
 *
 * Throws `RangeError` on an unparseable string, deliberately: a malformed
 * timestamp is a data-integrity problem, and silently serving `null` for it
 * would hide a corrupt row behind a plausible-looking response.
 */
export const isoOrNull = (d: Date | string | number | null | undefined): string | null =>
  (d ? new Date(d).toISOString() : null);
