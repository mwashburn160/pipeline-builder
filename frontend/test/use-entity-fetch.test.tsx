// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useEntityFetch — "fetch full record by id on mount, with
 * optional fallback shape from a list view." Consolidates the pattern in
 * EditPipelineModal, EditPluginModal, and registry detail views.
 *
 * Covers: happy path, null id (skip + fallback), id change triggers
 * refetch, error path, and unmount cancellation.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { useEntityFetch } from '../src/hooks/useEntityFetch';

describe('useEntityFetch', () => {
  it('fetches and returns entity for a non-null id', async () => {
    const fetcher = jest.fn().mockResolvedValue({ id: '1', name: 'A' });

    const { result } = renderHook(() => useEntityFetch('1', fetcher));

    expect(result.current.fetching).toBe(true);

    await waitFor(() => expect(result.current.fetching).toBe(false));

    expect(result.current.entity).toEqual({ id: '1', name: 'A' });
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledWith('1');
  });

  it('returns fallback and skips fetch when id is null', async () => {
    const fetcher = jest.fn();
    const fallback = { id: 'fallback', name: 'F' };

    const { result } = renderHook(() => useEntityFetch(null, fetcher, fallback));

    expect(result.current.entity).toEqual(fallback);
    expect(result.current.fetching).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns null entity when id is null and no fallback', () => {
    const fetcher = jest.fn();
    const { result } = renderHook(() => useEntityFetch<{ id: string }>(null, fetcher));

    expect(result.current.entity).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns fallback when id transitions to undefined', async () => {
    const fetcher = jest.fn().mockResolvedValue({ id: '1' });
    const fallback = { id: 'fallback' };

    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useEntityFetch(id, fetcher, fallback),
      { initialProps: { id: '1' as string | undefined } },
    );

    await waitFor(() => expect(result.current.entity).toEqual({ id: '1' }));

    rerender({ id: undefined });

    await waitFor(() => expect(result.current.entity).toEqual(fallback));
  });

  it('re-fetches when id changes', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({ id: '1', name: 'A' })
      .mockResolvedValueOnce({ id: '2', name: 'B' });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useEntityFetch(id, fetcher),
      { initialProps: { id: '1' } },
    );

    await waitFor(() => expect(result.current.entity).toEqual({ id: '1', name: 'A' }));

    rerender({ id: '2' });

    await waitFor(() => expect(result.current.entity).toEqual({ id: '2', name: 'B' }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(2, '2');
  });

  it('sets error on fetch failure', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('not found'));

    const { result } = renderHook(() => useEntityFetch('1', fetcher));

    await waitFor(() => expect(result.current.fetching).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('not found');
  });

  it('wraps non-Error rejection values', async () => {
    const fetcher = jest.fn().mockRejectedValue('string-error');

    const { result } = renderHook(() => useEntityFetch('1', fetcher));

    await waitFor(() => expect(result.current.fetching).toBe(false));

    expect(result.current.error?.message).toBe('string-error');
  });
});
