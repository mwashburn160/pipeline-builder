// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useListPage — the paginated/filterable list primitive behind most
 * dashboard pages.
 *
 * It had no direct test. Its hand-rolled fetch loop was refactored onto
 * `fetchCore.runCancellableFetch`, and the only coverage was `fetch-core`'s
 * (which tests the primitive, not this hook's use of it) plus whole-page suites
 * (which would report a cancellation bug as a flaky page). The behaviours below
 * are the ones a consumer would silently lose:
 *
 *   - a superseded fetch is ABORTED and its late answer discarded — the reason
 *     the signal exists, and what keeps a slow first keystroke from overwriting
 *     the results of a later one;
 *   - a filter change returns to page 0, or the viewer lands on page 5 of a
 *     result set that now has two pages;
 *   - `enabled: false` fetches nothing, so a page cannot issue an
 *     unauthenticated request before its guard resolves;
 *   - `primary` fields are excluded from `advancedFilterCount`, which drives
 *     the "N filters active" badge.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';

jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());

import { useListPage } from '../src/hooks/useListPage';

const FIELDS = [
  { key: 'search', type: 'text' as const, defaultValue: '', primary: true },
  { key: 'status', type: 'select' as const, defaultValue: 'all' },
];

/** A fetcher that records the params it saw and answers with one row. */
function recordingFetcher() {
  const seen: Array<Record<string, string>> = [];
  const fn = jest.fn<AnyFn>(async (params: Record<string, string>) => {
    seen.push({ ...params });
    return { items: ['row'], pagination: { total: 1, offset: 0 } };
  });
  return { fn, seen };
}

describe('useListPage', () => {
  it('fetches on mount and exposes the rows', async () => {
    const { fn } = recordingFetcher();
    const { result } = renderHook(() => useListPage<string>({ fields: FIELDS, fetcher: fn }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(['row']);
    expect(result.current.error).toBeNull();
  });

  it('does not fetch at all while `enabled` is false', async () => {
    const { fn } = recordingFetcher();
    renderHook(() => useListPage<string>({ fields: FIELDS, fetcher: fn, enabled: false }));

    // Nothing to wait FOR, so settle the queue and assert the absence.
    await act(async () => { await Promise.resolve(); });
    expect(fn).not.toHaveBeenCalled();
  });

  it('ABORTS the superseded fetch and keeps the later answer', async () => {
    const signals: AbortSignal[] = [];
    let release: (() => void) | null = null;
    const fetcher = jest.fn<AnyFn>(async (params: Record<string, string>, signal: AbortSignal) => {
      signals.push(signal);
      // Hold the FIRST request open so the second overtakes it — the race this
      // hook has to win.
      if (signals.length === 1) {
        await new Promise<void>((resolve) => { release = resolve; });
        return { items: ['stale'], pagination: { total: 1, offset: 0 } };
      }
      return { items: [`fresh:${params.status}`], pagination: { total: 1, offset: 0 } };
    });

    const { result } = renderHook(() => useListPage<string>({ fields: FIELDS, fetcher }));
    await waitFor(() => expect(signals).toHaveLength(1));

    // A select field is immediate (no debounce), so this supersedes at once.
    act(() => { result.current.updateFilter('status', 'active'); });
    await waitFor(() => expect(signals).toHaveLength(2));

    // The abandoned request is cancelled ON THE WIRE, not merely ignored.
    expect(signals[0].aborted).toBe(true);

    await waitFor(() => expect(result.current.data).toEqual(['fresh:active']));

    // Now let the stale one finish: its answer must NOT land.
    await act(async () => { release?.(); await Promise.resolve(); });
    expect(result.current.data).toEqual(['fresh:active']);
  });

  it('returns to the first page when a filter changes', async () => {
    // A total big enough for page 2 to EXIST: with `total: 1` the hook clamps
    // the offset back to 0 (correctly), and the test would prove nothing.
    const seen: Array<Record<string, string>> = [];
    const fn = jest.fn<AnyFn>(async (params: Record<string, string>) => {
      seen.push({ ...params });
      return { items: ['row'], pagination: { total: 500, offset: Number(params.offset ?? 0) } };
    });
    const { result } = renderHook(() => useListPage<string>({ fields: FIELDS, fetcher: fn }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => { result.current.handlePageChange(50); });
    await waitFor(() => expect(result.current.pagination.offset).toBe(50));

    act(() => { result.current.updateFilter('status', 'active'); });
    // Otherwise the viewer sits on an offset the narrowed result set no longer
    // reaches, and the list reads as empty.
    await waitFor(() => expect(result.current.pagination.offset).toBe(0));
    expect(seen[seen.length - 1].offset).toBe('0');
  });

  it('counts only NON-primary filters toward the advanced badge', async () => {
    const { fn } = recordingFetcher();
    const { result } = renderHook(() => useListPage<string>({ fields: FIELDS, fetcher: fn }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // The primary search bar is always visible, so it is not "an advanced
    // filter you forgot you set" — the badge exists to surface those.
    act(() => { result.current.updateFilter('search', 'abc'); });
    await waitFor(() => expect(result.current.hasActiveFilters).toBe(true));
    expect(result.current.advancedFilterCount).toBe(0);

    act(() => { result.current.updateFilter('status', 'active'); });
    await waitFor(() => expect(result.current.advancedFilterCount).toBe(1));
  });

  it('surfaces a failure as a string and stops loading', async () => {
    const fetcher = jest.fn<AnyFn>(async () => { throw new Error('boom'); });
    const { result } = renderHook(() => useListPage<string>({ fields: FIELDS, fetcher }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toContain('boom');
    expect(result.current.data).toEqual([]);
  });

  it('clearFilters restores every default', async () => {
    const { fn } = recordingFetcher();
    const { result } = renderHook(() => useListPage<string>({ fields: FIELDS, fetcher: fn }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => { result.current.updateFilter('status', 'active'); });
    await waitFor(() => expect(result.current.hasActiveFilters).toBe(true));

    act(() => { result.current.clearFilters(); });
    await waitFor(() => expect(result.current.hasActiveFilters).toBe(false));
    expect(result.current.filters).toEqual({ search: '', status: 'all' });
  });
});
