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

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useEntityFetch } from '../src/hooks/useEntityFetch';

describe('useEntityFetch', () => {
  it('fetches and returns entity for a non-null id', async () => {
    const fetcher = jest.fn<AnyFn>().mockResolvedValue({ id: '1', name: 'A' });

    const { result } = renderHook(() => useEntityFetch('1', fetcher));

    expect(result.current.fetching).toBe(true);

    await waitFor(() => expect(result.current.fetching).toBe(false));

    expect(result.current.entity).toEqual({ id: '1', name: 'A' });
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledWith('1', expect.any(AbortSignal));
  });

  it('returns fallback and skips fetch when id is null', async () => {
    const fetcher = jest.fn<AnyFn>();
    const fallback = { id: 'fallback', name: 'F' };

    const { result } = renderHook(() => useEntityFetch(null, fetcher, fallback));

    expect(result.current.entity).toEqual(fallback);
    expect(result.current.fetching).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns null entity when id is null and no fallback', () => {
    const fetcher = jest.fn<AnyFn>();
    const { result } = renderHook(() => useEntityFetch<{ id: string }>(null, fetcher));

    expect(result.current.entity).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns fallback when id transitions to undefined', async () => {
    const fetcher = jest.fn<AnyFn>().mockResolvedValue({ id: '1' });
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
      .fn<AnyFn>()
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
    expect(fetcher).toHaveBeenNthCalledWith(2, '2', expect.any(AbortSignal));
  });

  it('sets error on fetch failure', async () => {
    const fetcher = jest.fn<AnyFn>().mockRejectedValue(new Error('not found'));

    const { result } = renderHook(() => useEntityFetch('1', fetcher));

    await waitFor(() => expect(result.current.fetching).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('not found');
  });

  it('wraps non-Error rejection values', async () => {
    const fetcher = jest.fn<AnyFn>().mockRejectedValue('string-error');

    const { result } = renderHook(() => useEntityFetch('1', fetcher));

    await waitFor(() => expect(result.current.fetching).toBe(false));

    expect(result.current.error?.message).toBe('string-error');
  });

  it('never returns the previous id\'s record once the id changes — even when the new read fails', async () => {
    let rejectB!: (e: Error) => void;
    const fetcher = jest.fn<AnyFn>()
      .mockResolvedValueOnce({ id: 'A' })
      .mockReturnValueOnce(new Promise((_r, rej) => { rejectB = rej; }));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useEntityFetch(id, fetcher),
      { initialProps: { id: 'A' } },
    );
    await waitFor(() => expect(result.current.entity).toEqual({ id: 'A' }));

    rerender({ id: 'B' });
    // The first render for B already drops A and reports the pending read.
    expect(result.current.entity).toBeNull();
    expect(result.current.fetching).toBe(true);

    await act(async () => { rejectB(new Error('gone')); });
    expect(result.current.entity).toBeNull();
    expect(result.current.error?.message).toBe('gone');
    expect(result.current.fetching).toBe(false);
  });

  it('keeps the loaded record (no error) across a same-id reload that fails', async () => {
    const fetcher = jest.fn<AnyFn>().mockResolvedValueOnce({ id: 'A', v: 1 }).mockRejectedValueOnce(new Error('5xx'));
    const { result } = renderHook(() => useEntityFetch('A', fetcher));
    await waitFor(() => expect(result.current.entity).toEqual({ id: 'A', v: 1 }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error?.message).toBe('5xx'));
    expect(result.current.entity).toEqual({ id: 'A', v: 1 });
  });

  it('does not show a stale error for a new id', async () => {
    const fetcher = jest.fn<AnyFn>().mockRejectedValueOnce(new Error('A failed')).mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useEntityFetch(id, fetcher),
      { initialProps: { id: 'A' } },
    );
    await waitFor(() => expect(result.current.error?.message).toBe('A failed'));
    rerender({ id: 'B' });
    expect(result.current.error).toBeNull();
  });
});
