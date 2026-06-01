// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useFetch — the generic fetch-once-or-on-deps-change hook that
 * replaced ~7 hand-rolled `setLoading / cancelled flag / setError` blocks.
 *
 * Covers: happy path, error path, manual refetch, and unmount-cancellation
 * (the hook must NOT set state after the consumer unmounts).
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useFetch } from '../src/hooks/useFetch';

describe('useFetch', () => {
  it('returns data and clears loading on success', async () => {
    const fetcher = jest.fn().mockResolvedValue({ items: [1, 2, 3] });

    const { result } = renderHook(() => useFetch(fetcher, []));

    // Initial state
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual({ items: [1, 2, 3] });
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sets error and does not throw on failure', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useFetch(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.data).toBeNull();
  });

  it('wraps non-Error rejection values', async () => {
    const fetcher = jest.fn().mockRejectedValue('string-error');

    const { result } = renderHook(() => useFetch(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('string-error');
  });

  it('refetch triggers a new call', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({ v: 1 })
      .mockResolvedValueOnce({ v: 2 });

    const { result } = renderHook(() => useFetch(fetcher, []));

    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));

    act(() => result.current.refetch());

    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when deps change', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce('a')
      .mockResolvedValueOnce('b');

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useFetch(() => fetcher(key), [key]),
      { initialProps: { key: 'first' } },
    );

    await waitFor(() => expect(result.current.data).toBe('a'));

    rerender({ key: 'second' });

    await waitFor(() => expect(result.current.data).toBe('b'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not set state after unmount', async () => {
    // Defer the fetcher resolution until after unmount so we can prove the
    // hook's `cancelled` flag suppresses the state writes. We don't have
    // direct access to internal state after unmount, so we verify by
    // capturing the last-seen state via a tracker before unmount and
    // confirming no console.error is emitted (a side-effect of state
    // updates on unmounted React components in dev mode).
    let resolveFetch: (val: unknown) => void = () => {};
    const pending = new Promise<unknown>(r => { resolveFetch = r; });
    const fetcher = jest.fn().mockReturnValue(pending);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useFetch(fetcher, []));
    // Snapshot pre-unmount state for sanity
    expect(result.current.loading).toBe(true);

    unmount();

    // Resolve AFTER unmount — the hook should swallow the state write.
    // No throw, no warning is the success signal.
    await resolveFetch({ ok: true });
    await pending;
    // Yield to the microtask queue so the .then/.finally handlers run
    await new Promise(r => setTimeout(r, 0));

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
