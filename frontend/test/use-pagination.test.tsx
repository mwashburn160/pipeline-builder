// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `usePagination` is THE server-pagination convention — the page triple, the
 * page-size default and the clamp rule, in one place.
 *
 * Five shapes used to spell this out separately and the "clamp the offset when
 * the total shrank" rule was written four times, three of them differently.
 * Pinned here: the clamp, the settle that follows it, the page-1 reset on a
 * resize, and the fact that the total reaches the pager in the SAME render (an
 * effect would leave one paint showing rows under a "Showing 0–0 of 0" pager).
 */

import { describe, it, expect } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_PAGE_SIZE, clampOffset, usePagination } from '../src/hooks/usePagination';

describe('clampOffset', () => {
  it('snaps past-the-end offsets to the last real page', () => {
    expect(clampOffset(75, 30, 25)).toBe(25);
    expect(clampOffset(25, 30, 25)).toBe(25);
    expect(clampOffset(25, 25, 25)).toBe(0);
  });

  it('is 0 when there is nothing to show', () => {
    expect(clampOffset(75, 0, 25)).toBe(0);
    expect(clampOffset(75, 30, 0)).toBe(0);
    expect(clampOffset(-5, 30, 25)).toBe(0);
  });
});

describe('usePagination', () => {
  it('starts on page 1 at the shared default size', () => {
    const { result } = renderHook(() => usePagination());
    expect(result.current.withTotal(100)).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0, total: 100 });
  });

  it('gives the pager the total in the SAME render it is known', () => {
    const { result } = renderHook(() => usePagination());
    // No act(), no effect flush: the value is derived, not pushed in later.
    expect(result.current.withTotal(42).total).toBe(42);
  });

  it('clamps AND settles when a delete shrinks the set under the viewer', () => {
    const { result } = renderHook(() => usePagination());
    act(() => { result.current.setOffset(50); });
    expect(result.current.offset).toBe(50);

    // 30 rows at 25/page: page 3 is gone, so the pager shows page 2 …
    let shown!: { offset: number };
    act(() => { shown = result.current.withTotal(30); });
    expect(shown.offset).toBe(25);
    // … and the stored offset follows, so the next read asks for a real page.
    expect(result.current.offset).toBe(25);
  });

  it('leaves the offset alone on a total of 0 — that is also an unanswered read', () => {
    const { result } = renderHook(() => usePagination());
    act(() => { result.current.setOffset(50); });
    act(() => { result.current.withTotal(0); });
    expect(result.current.offset).toBe(50);
  });

  it('returns to page 1 on a resize and on a filter reset', () => {
    const { result } = renderHook(() => usePagination());
    act(() => { result.current.setOffset(50); });
    act(() => { result.current.setLimit(50); });
    expect(result.current.limit).toBe(50);
    expect(result.current.offset).toBe(0);

    act(() => { result.current.setOffset(100); });
    act(() => { result.current.reset(); });
    expect(result.current.offset).toBe(0);
  });

  it('honours a surface that has a design reason for its own page size', () => {
    const { result } = renderHook(() => usePagination(24));
    expect(result.current.limit).toBe(24);
  });
});
