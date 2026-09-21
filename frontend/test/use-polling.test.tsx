// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach, afterEach, beforeAll } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act } from '@testing-library/react';
import { usePolling } from '../src/hooks/usePolling';

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePolling', () => {
  beforeAll(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });

  beforeEach(() => {
    jest.useFakeTimers();
    visibility = 'visible';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs immediately, then every interval', () => {
    const fn = jest.fn<AnyFn>();
    renderHook(() => usePolling(fn, 1000));
    expect(fn).toHaveBeenCalledTimes(1);
    act(() => { jest.advanceTimersByTime(3000); });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('skips the immediate call when immediate is false', () => {
    const fn = jest.fn<AnyFn>();
    renderHook(() => usePolling(fn, 1000, { immediate: false }));
    expect(fn).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1000); });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('pauses while hidden and catches up when the tab is visible again', () => {
    const fn = jest.fn<AnyFn>();
    renderHook(() => usePolling(fn, 1000));
    fn.mockClear();

    act(() => { setVisibility('hidden'); });
    act(() => { jest.advanceTimersByTime(5000); });
    expect(fn).not.toHaveBeenCalled();

    act(() => { setVisibility('visible'); });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while hidden when pauseWhenHidden is false', () => {
    const fn = jest.fn<AnyFn>();
    renderHook(() => usePolling(fn, 1000, { pauseWhenHidden: false, immediate: false }));
    act(() => { setVisibility('hidden'); });
    act(() => { jest.advanceTimersByTime(2000); });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does nothing while disabled or with a non-positive interval, and stops on unmount', () => {
    const fn = jest.fn<AnyFn>();
    const { rerender, unmount } = renderHook(
      ({ enabled, ms }: { enabled: boolean; ms: number }) => usePolling(fn, ms, { enabled }),
      { initialProps: { enabled: false, ms: 1000 } },
    );
    act(() => { jest.advanceTimersByTime(5000); });
    expect(fn).not.toHaveBeenCalled();

    rerender({ enabled: true, ms: 0 });
    act(() => { jest.advanceTimersByTime(5000); });
    expect(fn).not.toHaveBeenCalled();

    rerender({ enabled: true, ms: 1000 });
    expect(fn).toHaveBeenCalledTimes(1);
    unmount();
    act(() => { jest.advanceTimersByTime(5000); setVisibility('visible'); });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls the latest callback without restarting the timer', () => {
    const first = jest.fn<AnyFn>();
    const second = jest.fn<AnyFn>();
    const { rerender } = renderHook(({ fn }) => usePolling(fn, 1000), { initialProps: { fn: first } });
    act(() => { jest.advanceTimersByTime(500); });
    rerender({ fn: second });
    act(() => { jest.advanceTimersByTime(500); });
    expect(first).toHaveBeenCalledTimes(1); // the immediate call only
    expect(second).toHaveBeenCalledTimes(1); // the 1000ms tick, on schedule
  });
});
