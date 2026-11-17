// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Load more" appends the next keyset page once per cursor: a second click that
 * lands before the first page arrives must not fetch (and append) it again.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCursorPages, type CursorPage } from '../src/hooks/useCursorPages';

describe('useCursorPages.loadMore', () => {
  it('ignores a second click while the next page is loading', async () => {
    let answer: (page: CursorPage<string>) => void = () => undefined;
    const fetchPage = jest.fn<AnyFn>(async (cursor?: string) => (cursor
      ? new Promise<CursorPage<string>>((resolve) => { answer = resolve; })
      : { items: ['a'], hasMore: true, nextCursor: 'c1' }));
    const { result } = renderHook(() => useCursorPages<string>(fetchPage as never, []));
    await waitFor(() => expect(result.current.rows).toEqual(['a']));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.loadMore();
      second = result.current.loadMore();
    });
    await act(async () => {
      answer({ items: ['b'], hasMore: false });
      await Promise.all([first, second]);
    });

    expect(fetchPage.mock.calls.filter(([cursor]) => cursor === 'c1')).toHaveLength(1);
    expect(result.current.rows).toEqual(['a', 'b']);
    expect(result.current.loadingMore).toBe(false);
  });
});
