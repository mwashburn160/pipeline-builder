// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react';
import { useFetch } from './useFetch';

/** One page of a keyset-paged list: `nextCursor` is opaque and sent back verbatim. */
export interface CursorPage<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

/** The pages after the first, tied to the first page they continue. */
interface Appended<T> {
  base: CursorPage<T>;
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * A first page read with `useFetch`, plus "Load more" pages appended after it.
 *
 * The appended pages belong to the FIRST page object they continue: a
 * `refetch()` or a deps change produces a new first page, and the appended rows
 * drop from that same render — a continuation of an older read must never be
 * glued onto a newer one (its cursor points into a list that has since moved).
 */
export function useCursorPages<T>(
  fetchPage: (cursor: string | undefined, signal?: AbortSignal) => Promise<CursorPage<T>>,
  deps: ReadonlyArray<unknown>,
) {
  const first = useFetch((signal) => fetchPage(undefined, signal), deps);
  const [appended, setAppended] = useState<Appended<T> | null>(null);
  const [moreError, setMoreError] = useState<{ base: CursorPage<T>; message: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Synchronous twin of `loadingMore`: two clicks inside one render both see
  // the state flag false, and would append the same cursor's page twice.
  const loadingMoreRef = useRef(false);

  const base = first.data;
  const more = base && appended?.base === base ? appended : null;
  const hasMore = more ? more.hasMore : !!base?.hasMore;
  const nextCursor = more ? more.nextCursor : base?.nextCursor;

  const loadMore = async () => {
    if (!base || !hasMore || !nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchPage(nextCursor);
      setAppended((prev) => ({
        base,
        items: [...(prev?.base === base ? prev.items : []), ...page.items],
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      }));
    } catch (err) {
      setMoreError({ base, message: err instanceof Error ? err.message : 'Could not load more' });
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  return {
    /** Every loaded row: the first page, then each appended page. */
    rows: base ? [...base.items, ...(more?.items ?? [])] : [],
    loading: first.loading,
    error: first.error,
    /** Re-read the first page; the appended pages drop. */
    refetch: first.refetch,
    /** Another page exists AND the server gave a cursor to reach it. */
    hasMore: hasMore && !!nextCursor,
    loadMore,
    loadingMore,
    moreError: base && moreError?.base === base ? moreError.message : null,
  };
}
