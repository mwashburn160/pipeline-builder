// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useFetch — the generic fetch-once-or-on-deps-change hook that
 * replaced ~7 hand-rolled `setLoading / cancelled flag / setError` blocks.
 *
 * Covers: happy path, error path, manual refetch, and unmount-cancellation
 * (the hook must NOT set state after the consumer unmounts).
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useFetch } from '../src/hooks/useFetch';

describe('useFetch', () => {
  it('returns data and clears loading on success', async () => {
    const fetcher = jest.fn<AnyFn>().mockResolvedValue({ items: [1, 2, 3] });

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
    const fetcher = jest.fn<AnyFn>().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useFetch(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.data).toBeNull();
  });

  it('wraps non-Error rejection values', async () => {
    const fetcher = jest.fn<AnyFn>().mockRejectedValue('string-error');

    const { result } = renderHook(() => useFetch(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('string-error');
  });

  it('refetch triggers a new call', async () => {
    const fetcher = jest
      .fn<AnyFn>()
      .mockResolvedValueOnce({ v: 1 })
      .mockResolvedValueOnce({ v: 2 });

    const { result } = renderHook(() => useFetch(fetcher, []));

    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));

    act(() => { void result.current.refetch(); });

    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when deps change', async () => {
    const fetcher = jest
      .fn<AnyFn>()
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
    const fetcher = jest.fn<AnyFn>().mockReturnValue(pending);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useFetch(fetcher, []));
    // Snapshot pre-unmount state for sanity
    expect(result.current.loading).toBe(true);

    unmount();

    // Resolve AFTER unmount — the hook should swallow the state write.
    // No throw, no warning is the success signal.
    // `act` flushes the .then/.finally handlers queued by the resolution.
    await act(async () => {
      resolveFetch({ ok: true });
      await pending;
    });

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('useFetch options and awaitable refetch', () => {
  it('calls onSuccess with the value and onError with a failure, keeping prior data', async () => {
    const onSuccess = jest.fn<AnyFn>();
    const onError = jest.fn<AnyFn>();
    const fetcher = jest.fn<AnyFn>().mockResolvedValueOnce({ v: 1 }).mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useFetch(fetcher, [], { onSuccess, onError }));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));
    expect(onSuccess).toHaveBeenCalledWith({ v: 1 });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.refetch(); });
    let ok: boolean | undefined;
    await act(async () => { ok = await pending; });
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'down' }));
    expect(result.current.data).toEqual({ v: 1 });
    expect(result.current.error?.message).toBe('down');
  });

  it('resolves refetch with true once the triggered run succeeds', async () => {
    const fetcher = jest.fn<AnyFn>().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const { result } = renderHook(() => useFetch(fetcher, []));
    await waitFor(() => expect(result.current.data).toBe(1));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.refetch(); });
    let ok: boolean | undefined;
    await act(async () => { ok = await pending; });
    expect(ok).toBe(true);
    expect(result.current.data).toBe(2);
  });

  it('resolves refetch with false on a disabled reader instead of hanging', async () => {
    // No run starts while disabled, so nothing else would ever settle the
    // promise — a caller awaiting it (a save's onSuccess) stayed pending for
    // good, or was later handed an unrelated run's outcome.
    const fetcher = jest.fn<AnyFn>().mockResolvedValue('loaded');
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useFetch(fetcher, [], { enabled }),
      { initialProps: { enabled: false } },
    );
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.refetch(); });
    let ok: boolean | undefined;
    await act(async () => { ok = await pending; });
    expect(ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    // Enabling later runs normally and is not attributed to the old refetch.
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toBe('loaded'));
  });
});

describe('useFetch: data belongs to the deps it was read for', () => {
  it('returns null (and loading) from the first render after a deps change, and after a failed read for the new deps', async () => {
    let rejectB!: (e: Error) => void;
    const fetcher = jest.fn<AnyFn>()
      .mockResolvedValueOnce('A-data')
      .mockReturnValueOnce(new Promise((_r, rej) => { rejectB = rej; }));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useFetch(() => fetcher(id), [id]),
      { initialProps: { id: 'A' } },
    );
    await waitFor(() => expect(result.current.data).toBe('A-data'));

    rerender({ id: 'B' });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => { rejectB(new Error('B failed')); });
    expect(result.current.data).toBeNull();
    expect(result.current.error?.message).toBe('B failed');
  });

  it('does not resurface A\'s answer when going back to A while its re-read is in flight', async () => {
    const fetcher = jest.fn<AnyFn>()
      .mockResolvedValueOnce('A-data')
      .mockResolvedValueOnce('B-data')
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useFetch(() => fetcher(id), [id]),
      { initialProps: { id: 'A' } },
    );
    await waitFor(() => expect(result.current.data).toBe('A-data'));
    rerender({ id: 'B' });
    await waitFor(() => expect(result.current.data).toBe('B-data'));
    rerender({ id: 'A' });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('drops data and error when enabled turns false', async () => {
    const fetcher = jest.fn<AnyFn>().mockResolvedValue('loaded');
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useFetch(fetcher, [], { enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.data).toBe('loaded'));
    rerender({ enabled: false });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    // Re-enabling starts a fresh read rather than flashing the old value.
    fetcher.mockReturnValueOnce(new Promise(() => {}));
    rerender({ enabled: true });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('keepPreviousData keeps the last page on screen while the next loads, and after enabled turns false', async () => {
    let resolvePage2!: (v: string) => void;
    const fetcher = jest.fn<AnyFn>()
      .mockResolvedValueOnce('page-1')
      .mockReturnValueOnce(new Promise((r) => { resolvePage2 = r; }));
    const { result, rerender } = renderHook(
      ({ offset, enabled }: { offset: number; enabled: boolean }) =>
        useFetch(() => fetcher(offset), [offset], { keepPreviousData: true, enabled }),
      { initialProps: { offset: 0, enabled: true } },
    );
    await waitFor(() => expect(result.current.data).toBe('page-1'));
    rerender({ offset: 25, enabled: true });
    expect(result.current.data).toBe('page-1');
    expect(result.current.loading).toBe(true);
    await act(async () => { resolvePage2('page-2'); });
    expect(result.current.data).toBe('page-2');
    rerender({ offset: 25, enabled: false });
    expect(result.current.data).toBe('page-2');
  });

  it('a refetch (same deps) keeps data while in flight', async () => {
    const fetcher = jest.fn<AnyFn>().mockResolvedValueOnce('v1').mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useFetch(fetcher, []));
    await waitFor(() => expect(result.current.data).toBe('v1'));
    act(() => { void result.current.refetch(); });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe('v1');
  });
});
