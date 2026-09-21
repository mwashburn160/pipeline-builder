// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The React binding over the shared read cache, and the cancellation the list
 * hook now gets for free.
 *
 * `query-cache.test.ts` pins the store; these pin what a component actually
 * sees: two panels asking the same question issue one request, a mutation
 * re-reads every mounted consumer, an org switch drops what they were showing,
 * and a superseded/unmounted read is aborted rather than merely ignored.
 */

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useQuery } from '../src/hooks/useQuery';
import { useListPage } from '../src/hooks/useListPage';
import { clearQueryCache, invalidateQueries, type Query } from '../src/lib/query-cache';

jest.mock('next/router', () => ({
  useRouter: () => ({ query: {}, isReady: true, pathname: '/x', replace: jest.fn() }),
}));

/** A descriptor whose run() is a spy, rebuilt each render like a real call site. */
function counting(key: string, value = 'v') {
  const run = jest.fn((_signal: AbortSignal) => Promise.resolve(value));
  return { query: (): Query<string> => ({ key, run, staleMs: 10_000 }), run };
}

describe('useQuery', () => {
  it('two components asking the same question issue ONE request', async () => {
    const { query, run } = counting('k');
    function Panel({ label }: { label: string }) {
      const { data } = useQuery(query());
      return <span>{label}:{data ?? '…'}</span>;
    }
    render(<><Panel label="a" /><Panel label="b" /></>);

    await screen.findByText('a:v');
    await screen.findByText('b:v');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stays idle when disabled, then reads once enabled', async () => {
    const { query, run } = counting('k');
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useQuery(query(), { enabled: on }),
      { initialProps: { on: false } },
    );
    expect(run).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);

    rerender({ on: true });
    await waitFor(() => expect(result.current.data).toBe('v'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('re-reads every mounted consumer when a mutation invalidates the key', async () => {
    const { query, run } = counting('pipelines?limit=1');
    const { result } = renderHook(() => useQuery(query()));
    await waitFor(() => expect(result.current.data).toBe('v'));
    expect(run).toHaveBeenCalledTimes(1);

    act(() => { invalidateQueries('pipelines?'); });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it('ignores an invalidation of a key it does not read', async () => {
    const { query, run } = counting('subscription');
    const { result } = renderHook(() => useQuery(query()));
    await waitFor(() => expect(result.current.data).toBe('v'));

    act(() => { invalidateQueries('pipelines?'); });

    // Scoped per key: an unrelated mutation must not tear down and re-issue
    // every other read in the tree.
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('an org switch drops what the hook was showing and re-reads', async () => {
    const { query, run } = counting('k');
    const { result } = renderHook(() => useQuery(query()));
    await waitFor(() => expect(result.current.data).toBe('v'));

    // What `AuthProvider.clearSessionCaches` does on switchOrganization/logout.
    act(() => { clearQueryCache(); });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it('aborts the request when the consumer unmounts', async () => {
    let seen: AbortSignal | null = null;
    const query = (): Query<string> => ({
      key: 'k',
      run: (signal) => { seen = signal; return new Promise(() => { /* still on the wire */ }); },
    });
    const { unmount } = renderHook(() => useQuery(query()));
    await waitFor(() => expect(seen).not.toBeNull());

    expect(seen!.aborted).toBe(false);
    unmount();
    expect(seen!.aborted).toBe(true);
  });

  it('surfaces a real failure (an abort is not one)', async () => {
    const query = (): Query<string> => ({ key: 'k', run: () => Promise.reject(new Error('boom')) });
    const { result } = renderHook(() => useQuery(query()));
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    expect(result.current.loading).toBe(false);
  });
});

describe('useQuery — changing the key', () => {
  it('does not keep showing the PREVIOUS key while an uncached key loads', async () => {
    // A cache miss used to leave the previous key's data on screen — the
    // executions page kept the old date range's rows (and the stat cards built
    // from them) while the new range loaded.
    let resolveB!: (v: string) => void;
    const a: Query<string> = { key: 'range-a', run: () => Promise.resolve('rows-a'), staleMs: 10_000 };
    const b: Query<string> = { key: 'range-b', run: () => new Promise<string>((r) => { resolveB = r; }), staleMs: 10_000 };

    const { result, rerender } = renderHook(({ q }) => useQuery(q), { initialProps: { q: a } });
    await waitFor(() => expect(result.current.data).toBe('rows-a'));

    rerender({ q: b });
    expect(result.current.data).toBeNull();

    await act(async () => { resolveB('rows-b'); });
    expect(result.current.data).toBe('rows-b');
  });

  it('does not show the previous key\'s error on the new key', async () => {
    const failing: Query<string> = { key: 'bad', run: () => Promise.reject(new Error('boom')), staleMs: 10_000 };
    const pending: Query<string> = { key: 'next', run: () => new Promise<string>(() => {}), staleMs: 10_000 };

    const { result, rerender } = renderHook(({ q }) => useQuery(q), { initialProps: { q: failing } });
    await waitFor(() => expect(result.current.error).not.toBeNull());

    rerender({ q: pending });
    expect(result.current.error).toBeNull();
  });
});

describe('useListPage — cancellation', () => {
  it('aborts the superseded fetch when the filters change', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = jest.fn(async (_params: Record<string, string>, signal: AbortSignal) => {
      signals.push(signal);
      return { items: [] as string[] };
    });

    const { result } = renderHook(() => useListPage<string>({
      fields: [{ key: 'status', type: 'select', defaultValue: 'all' }],
      fetcher,
    }));

    await waitFor(() => expect(signals).toHaveLength(1));
    act(() => { result.current.updateFilter('status', 'failed'); });
    await waitFor(() => expect(signals).toHaveLength(2));

    // The first request is cancelled on the wire, not just ignored on arrival.
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('aborts the in-flight fetch on unmount', async () => {
    const signals: AbortSignal[] = [];
    const { unmount } = renderHook(() => useListPage<string>({
      fields: [],
      fetcher: async (_p, signal) => { signals.push(signal); return { items: [] as string[] }; },
    }));

    await waitFor(() => expect(signals).toHaveLength(1));
    unmount();
    expect(signals[0].aborted).toBe(true);
  });
});
