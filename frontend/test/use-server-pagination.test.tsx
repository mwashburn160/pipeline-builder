// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useServerPagination — the filter-state → reset-offset →
 * fetch → reconcile-server-pagination pattern consolidated from the
 * compliance/exemption/scan/rule-scan components.
 *
 * Covers: happy path, filter change resets offset, setOffset triggers
 * refetch, error path, manual refetch tick.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useServerPagination } from '../src/hooks/useServerPagination';

interface Row { id: string; }
type Filters = { q?: string };

function buildResult(items: Row[], total: number, offset = 0, limit = 20) {
  return { items, pagination: { offset, limit, total } };
}

describe('useServerPagination', () => {
  it('fetches and exposes items + pagination on mount', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      buildResult([{ id: '1' }, { id: '2' }], 42),
    );

    const { result } = renderHook(() =>
      useServerPagination<Row, Filters>(fetcher, {}, 20),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toEqual([{ id: '1' }, { id: '2' }]);
    expect(result.current.pagination.total).toBe(42);
    expect(result.current.pagination.offset).toBe(0);
    expect(result.current.pagination.limit).toBe(20);
    expect(fetcher).toHaveBeenCalledWith({ offset: 0, limit: 20, filters: {} });
  });

  it('resets offset to 0 when filters change', async () => {
    const fetcher = jest.fn().mockResolvedValue(buildResult([], 0));

    const { result, rerender } = renderHook(
      ({ filters }: { filters: Filters }) =>
        useServerPagination<Row, Filters>(fetcher, filters, 20),
      { initialProps: { filters: { q: 'a' } } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Advance the offset
    act(() => result.current.setOffset(40));
    await waitFor(() => expect(result.current.pagination.offset).toBe(40));

    // Change filters — must reset offset to 0
    rerender({ filters: { q: 'b' } });

    await waitFor(() => expect(result.current.pagination.offset).toBe(0));

    // Verify the last fetch was with offset=0 and new filters
    const lastCall = fetcher.mock.calls[fetcher.mock.calls.length - 1][0];
    expect(lastCall.offset).toBe(0);
    expect(lastCall.filters).toEqual({ q: 'b' });
  });

  it('setOffset triggers a re-fetch with the new offset', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(buildResult([{ id: 'page1' }], 100))
      .mockResolvedValueOnce(buildResult([{ id: 'page2' }], 100));

    const { result } = renderHook(() =>
      useServerPagination<Row, Filters>(fetcher, {}, 20),
    );

    await waitFor(() => expect(result.current.items).toEqual([{ id: 'page1' }]));

    act(() => result.current.setOffset(20));

    await waitFor(() => expect(result.current.items).toEqual([{ id: 'page2' }]));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith({ offset: 20, limit: 20, filters: {} });
  });

  it('sets error on fetcher rejection', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('server fail'));

    const { result } = renderHook(() =>
      useServerPagination<Row, Filters>(fetcher, {}, 20),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('server fail');
  });

  it('wraps non-Error rejection values', async () => {
    const fetcher = jest.fn().mockRejectedValue('string-err');

    const { result } = renderHook(() =>
      useServerPagination<Row, Filters>(fetcher, {}, 20),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error?.message).toBe('string-err');
  });

  it('refetch tick triggers a fresh call', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(buildResult([{ id: '1' }], 1))
      .mockResolvedValueOnce(buildResult([{ id: '1-updated' }], 1));

    const { result } = renderHook(() =>
      useServerPagination<Row, Filters>(fetcher, {}, 20),
    );

    await waitFor(() => expect(result.current.items).toEqual([{ id: '1' }]));

    act(() => result.current.refetch());

    await waitFor(() =>
      expect(result.current.items).toEqual([{ id: '1-updated' }]),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
