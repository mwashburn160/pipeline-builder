// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import type { PaginationState } from '@/components/ui/Pagination';

/**
 * ONE server-pagination convention for every list behind `<Pagination>`.
 *
 * There used to be five: `useListPage`, `useServerPagination`, loose
 * `[offset] + [limit]` pairs, a `[page: {offset, limit}]` object, and a full
 * `[{limit, offset, total}]` — with the "clamp the offset when the total shrank"
 * rule written four times (three of them differently) and `DEFAULT_PAGE_SIZE`
 * declared three times with two values.
 *
 * The convention is this hook — the page triple, the page-size default and the
 * clamp rule — and nothing else. It is deliberately NOT `useListPage`, the
 * widest-adopted of the five: that hook also owns the filter model, debouncing,
 * URL sync, the sort and the FETCH, while the surfaces on the other four shapes
 * fetch through `useFetch` / `useQuery` / `useCrudResource`, each with its own
 * cancellation, caching and stale-response guard. Moving them would have meant
 * rewriting a working fetch layer just to reach page state. So `useListPage` and
 * `useServerPagination` now build on this hook, and the loose shapes adopt it
 * directly: one clamp, one default, one state shape, no fetch layer disturbed.
 *
 * The server's `total` arrives through `withTotal(total)` DURING the consumer's
 * render, not through an effect: an effect settles a render after the list does,
 * so for one paint the rows are there while the pager still says
 * "Showing 0–0 of 0" and Next is disabled.
 *
 * @example
 * ```tsx
 * const page = usePagination();
 * const { data } = useFetch(
 *   async (signal) => api.listRoles({ limit: page.limit, offset: page.offset }, { signal }),
 *   [page.limit, page.offset],
 * );
 * const pagination = page.withTotal(data?.pagination.total ?? 0);
 *
 * <Pagination
 *   pagination={pagination}
 *   onPageChange={page.setOffset}
 *   onPageSizeChange={page.setLimit}
 * />
 * ```
 */

/** Rows per page for every list that has no design reason to differ. */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * The offset of the page that actually exists.
 *
 * THE clamp rule: a filter, a delete or a fresher total can shrink the result
 * set out from under the page the viewer is on, and an un-clamped offset then
 * renders an empty list with working page buttons. Snap to the last real page
 * (and to 0 when nothing is left) instead.
 */
export function clampOffset(offset: number, total: number, limit: number): number {
  if (total <= 0 || limit <= 0) return 0;
  const maxOffset = Math.floor((total - 1) / limit) * limit;
  return Math.min(Math.max(0, offset), maxOffset);
}

export interface UsePaginationResult {
  limit: number;
  /** The offset to ask the server for. */
  offset: number;
  /**
   * The pager's state for THIS render, with the clamp rule applied to the
   * server's total. Call it during render with the total you have — it also
   * settles the stored offset when the clamp bit, so the next read asks for the
   * page that now exists.
   */
  withTotal: (total: number) => PaginationState;
  /** `<Pagination onPageChange>`. */
  setOffset: (offset: number) => void;
  /** `<Pagination onPageSizeChange>` — a resize always returns to page 1. */
  setLimit: (limit: number) => void;
  /** A changed filter or sort starts again from page 1. */
  reset: () => void;
}

/**
 * Page state for one server-paginated list. See the module doc.
 *
 * @param initialLimit - Rows per page to start at; defaults to
 *   {@link DEFAULT_PAGE_SIZE}.
 */
export function usePagination(initialLimit: number = DEFAULT_PAGE_SIZE): UsePaginationResult {
  const [state, setState] = useState<{ limit: number; offset: number }>({ limit: initialLimit, offset: 0 });

  const setOffset = useCallback((next: number) => {
    setState((p) => (p.offset === next ? p : { ...p, offset: next }));
  }, []);

  const setLimit = useCallback((limit: number) => {
    setState((p) => (p.limit === limit ? p : { limit, offset: 0 }));
  }, []);

  const reset = useCallback(() => {
    setState((p) => (p.offset === 0 ? p : { ...p, offset: 0 }));
  }, []);

  const withTotal = (total: number): PaginationState => {
    const offset = clampOffset(state.offset, total, state.limit);
    // Settle the stored offset once a REAL total has clamped it (a delete or a
    // filter shrank the set), so the next read asks for a page that exists.
    // A render-phase update, deliberately: React re-renders before painting, so
    // the pager never shows the page that stopped existing. A total of 0 is
    // left alone — it is also what an unanswered read looks like, and the
    // viewer's offset must survive that.
    if (total > 0 && offset !== state.offset) {
      setState((p) => (p.offset === offset ? p : { ...p, offset }));
    }
    return { limit: state.limit, offset, total };
  };

  return { limit: state.limit, offset: state.offset, withTotal, setOffset, setLimit, reset };
}
