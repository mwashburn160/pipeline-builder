// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useListPage — the generic filter-state → debounce → reset-offset →
 * cancellable-fetch → reconcile-pagination hook that backs the paginated list
 * pages. Refactored this session onto the shared `runCancellableFetch` core, so
 * these lock in: initial fetch, filter-change offset reset, page/size handlers,
 * the `error: string` contract, and the `enabled:false` skip.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useListPage, type FilterField } from '../src/hooks/useListPage';

// useListPage now calls `useRouter()` for opt-in URL-sync. These tests don't pass
// `urlSync`, so the sync effects stay inert (guarded on `urlSync` + `isReady`);
// stub the router so the unconditional `useRouter()` call doesn't throw
// "NextRouter was not mounted" outside a <RouterContext>.
// `mockRouter` is reassignable so the urlSync test can flip `isReady` on.
let mockRouter: { query: Record<string, string>; isReady: boolean; pathname: string; replace: jest.Mock } =
  { query: {}, isReady: false, pathname: '/', replace: jest.fn() };
jest.mock('next/router', () => ({
  useRouter: () => mockRouter,
}));

interface Row { id: string; }

// A primary (debounced) text field + an immediate select field — mirrors the
// real list pages (search bar + status dropdown).
const fields: FilterField[] = [
  { key: 'q', type: 'text', defaultValue: '', primary: true },
  { key: 'status', type: 'select', defaultValue: 'all' },
];

/** Fetcher that echoes back the offset/limit it was called with, so the hook's
 *  "reconcile server offset" step keeps the offset the caller requested. */
function echoFetcher(total: number) {
  return jest.fn(async (params: Record<string, string>) => ({
    items: [{ id: params.offset }] as Row[],
    pagination: { total, offset: Number(params.offset) },
  }));
}

describe('useListPage', () => {
  it('fetches on mount and populates data + pagination.total', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      items: [{ id: '1' }, { id: '2' }],
      pagination: { total: 42, offset: 0 },
    });

    const { result } = renderHook(() => useListPage<Row>({ fields, fetcher }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual([{ id: '1' }, { id: '2' }]);
    expect(result.current.pagination.total).toBe(42);
    expect(result.current.pagination.offset).toBe(0);
    expect(result.current.pagination.limit).toBe(25); // default pageSize
    expect(result.current.error).toBeNull();
    // Default/empty filter values are omitted; only pagination params sent.
    expect(fetcher).toHaveBeenCalledWith({ limit: '25', offset: '0' }, expect.any(AbortSignal));
  });

  it('resets offset to 0 and refetches when a filter changes', async () => {
    const fetcher = echoFetcher(100);

    const { result } = renderHook(() => useListPage<Row>({ fields, fetcher }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Advance to a later page first.
    act(() => result.current.handlePageChange(50));
    await waitFor(() => expect(result.current.pagination.offset).toBe(50));

    // Changing the select filter must snap offset back to 0 and refetch.
    act(() => result.current.updateFilter('status', 'active'));
    await waitFor(() => expect(result.current.pagination.offset).toBe(0));

    const lastCall = fetcher.mock.calls[fetcher.mock.calls.length - 1][0];
    expect(lastCall.offset).toBe('0');
    expect(lastCall.status).toBe('active');
    expect(result.current.hasActiveFilters).toBe(true);
    // 'status' isn't primary, so it counts toward the advanced filter badge.
    expect(result.current.advancedFilterCount).toBe(1);
  });

  it('handlePageChange and handlePageSizeChange drive pagination + refetch', async () => {
    const fetcher = echoFetcher(100);

    const { result } = renderHook(() => useListPage<Row>({ fields, fetcher, pageSize: 10 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pagination.limit).toBe(10);

    act(() => result.current.handlePageChange(20));
    await waitFor(() => expect(result.current.pagination.offset).toBe(20));
    expect(fetcher).toHaveBeenLastCalledWith(expect.objectContaining({ offset: '20', limit: '10' }), expect.any(AbortSignal));

    // Changing page size resets offset to 0.
    act(() => result.current.handlePageSizeChange(50));
    await waitFor(() => expect(result.current.pagination.limit).toBe(50));
    expect(result.current.pagination.offset).toBe(0);
    expect(fetcher).toHaveBeenLastCalledWith(expect.objectContaining({ limit: '50', offset: '0' }), expect.any(AbortSignal));
  });

  it('sets error (as a string) when the fetcher rejects', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useListPage<Row>({ fields, fetcher }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(typeof result.current.error).toBe('string');
    expect(result.current.error).toBe('boom');
    expect(result.current.data).toEqual([]);
  });

  it('does not fetch when enabled is false', async () => {
    const fetcher = jest.fn().mockResolvedValue({ items: [], pagination: { total: 0, offset: 0 } });

    const { result } = renderHook(() => useListPage<Row>({ fields, fetcher, enabled: false }));

    // Flush effects — the fetch effect returns early before calling the fetcher.
    await act(async () => { await Promise.resolve(); });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
  });

  it('urlSync write-back keeps a fixed-size dep array when the select fields change', async () => {
    mockRouter = { query: {}, isReady: true, pathname: '/list', replace: jest.fn().mockResolvedValue(true) };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetcher = jest.fn().mockResolvedValue({ items: [], pagination: { total: 0, offset: 0 } });
      const twoSelects: FilterField[] = [...fields];
      const threeSelects: FilterField[] = [...fields, { key: 'kind', type: 'select', defaultValue: 'any' }];

      const { result, rerender } = renderHook(
        ({ f }: { f: FilterField[] }) => useListPage<Row>({ fields: f, fetcher, urlSync: true }),
        { initialProps: { f: twoSelects } },
      );
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // A conditionally-added select filter must not change the effect's dep-array size.
      rerender({ f: threeSelects });
      act(() => result.current.updateFilter('kind', 'custom'));
      await waitFor(() => expect(mockRouter.replace).toHaveBeenLastCalledWith(
        { pathname: '/list', query: { kind: 'custom' } }, undefined, { shallow: true },
      ));

      // Write-back still tracks select changes on the original field too.
      act(() => result.current.updateFilter('status', 'active'));
      await waitFor(() => expect(mockRouter.replace).toHaveBeenLastCalledWith(
        { pathname: '/list', query: { kind: 'custom', status: 'active' } }, undefined, { shallow: true },
      ));

      const sizeWarnings = errorSpy.mock.calls.filter((c) => c.some((arg) => String(arg).includes('changed size between renders')));
      expect(sizeWarnings).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      mockRouter = { query: {}, isReady: false, pathname: '/', replace: jest.fn() };
    }
  });
});
