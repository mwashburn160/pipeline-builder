// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export interface ListSummaryFlag<T> {
  /** Word shown after the count, e.g. "inactive" → "3 inactive". */
  label: string;
  /** Predicate selecting the items this flag counts (on the current page). */
  pred: (item: T) => boolean;
}

/**
 * Build the always-on result summary for a SERVER-paginated list:
 *   "Showing X of Y <noun>s · N <flag> · M <flag> on this page"
 * Flags count only the loaded page (hence "on this page"); omit ones at zero.
 * Returns `undefined` while loading so callers can skip rendering.
 */
export function buildListSummary<T>(
  items: T[],
  total: number,
  opts: { noun: string; isLoading: boolean; flags?: ListSummaryFlag<T>[] },
): string | undefined {
  if (opts.isLoading) return undefined;
  const base = `Showing ${items.length} of ${total} ${opts.noun}${total === 1 ? '' : 's'}`;
  const flags = (opts.flags ?? [])
    .map((f) => {
      const n = items.filter(f.pred).length;
      return n ? `${n} ${f.label}` : null;
    })
    .filter(Boolean);
  return flags.length ? `${base} · ${flags.join(' · ')} on this page` : base;
}
