// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useRowSelection` is the ONE row-selection implementation — the users,
 * invitations and registry-tag tables each had their own copy of it. The
 * header-checkbox variant (`toggleAll`) carries the interesting rules:
 *   - select-all acts on the ids it is GIVEN (the visible page, the pending
 *     rows, the tags in view), never the whole set
 *   - ids outside that slice are left alone, so a selection built across
 *     several searches survives
 */

import { describe, it, expect } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { useRowSelection, allSelected } from '../src/components/dashboard/BulkActionBar';

describe('useRowSelection', () => {
  it('toggles one id on and off', () => {
    const { result } = renderHook(() => useRowSelection());
    act(() => result.current.toggle('a'));
    expect([...result.current.selectedIds]).toEqual(['a']);
    act(() => result.current.toggle('a'));
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('selects every visible id when some or none are selected', () => {
    const { result } = renderHook(() => useRowSelection());
    act(() => result.current.toggle('a'));
    act(() => result.current.toggleAll(['a', 'b', 'c']));
    expect([...result.current.selectedIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('clears every visible id when all of them are already selected', () => {
    const { result } = renderHook(() => useRowSelection());
    act(() => result.current.toggleAll(['a', 'b']));
    act(() => result.current.toggleAll(['a', 'b']));
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('leaves ids outside the given slice untouched — a selection spans pages', () => {
    const { result } = renderHook(() => useRowSelection());
    act(() => result.current.toggle('off-page'));
    act(() => result.current.toggleAll(['a', 'b']));
    expect([...result.current.selectedIds].sort()).toEqual(['a', 'b', 'off-page']);
    // Deselect-all on the visible slice keeps the off-page pick.
    act(() => result.current.toggleAll(['a', 'b']));
    expect([...result.current.selectedIds]).toEqual(['off-page']);
  });

  it('does nothing for an empty slice (an empty page is not "all selected")', () => {
    const { result } = renderHook(() => useRowSelection());
    act(() => result.current.toggle('a'));
    act(() => result.current.toggleAll([]));
    expect([...result.current.selectedIds]).toEqual(['a']);
  });

  it('replaces the whole set (keeping only the rows a bulk action failed on)', () => {
    const { result } = renderHook(() => useRowSelection());
    act(() => result.current.toggleAll(['a', 'b', 'c']));
    act(() => result.current.replace(['b']));
    expect([...result.current.selectedIds]).toEqual(['b']);
    act(() => result.current.clear());
    expect(result.current.selectedIds.size).toBe(0);
  });
});

describe('allSelected', () => {
  it('is false for an empty slice, true only when every id is held', () => {
    expect(allSelected(new Set(['a']), [])).toBe(false);
    expect(allSelected(new Set(['a']), ['a'])).toBe(true);
    expect(allSelected(new Set(['a']), ['a', 'b'])).toBe(false);
    expect(allSelected(new Set(['a', 'b', 'z']), ['a', 'b'])).toBe(true);
  });
});
