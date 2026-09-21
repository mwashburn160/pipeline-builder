// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useAutoCloseTimer` holds the delayed "close this editor" timer the users page
 * hand-rolled twice. Its two rules are the ones the hand-rolled version had to
 * get right: a close scheduled for one subject must not survive re-opening on
 * another, and no timer may fire after unmount.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook } from '@testing-library/react';
import { useAutoCloseTimer } from '../src/hooks/useAutoCloseTimer';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('useAutoCloseTimer', () => {
  it('runs the callback after the delay', () => {
    const close = jest.fn<AnyFn>();
    const { result } = renderHook(() => useAutoCloseTimer());
    act(() => result.current.schedule(close, 1000));
    expect(close).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1000); });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('cancel drops a pending close', () => {
    const close = jest.fn<AnyFn>();
    const { result } = renderHook(() => useAutoCloseTimer());
    act(() => result.current.schedule(close, 1000));
    act(() => result.current.cancel());
    act(() => { jest.advanceTimersByTime(5000); });
    expect(close).not.toHaveBeenCalled();
  });

  it('a second schedule replaces the first — only the latest subject closes', () => {
    const first = jest.fn<AnyFn>();
    const second = jest.fn<AnyFn>();
    const { result } = renderHook(() => useAutoCloseTimer());
    act(() => result.current.schedule(first, 1000));
    act(() => result.current.schedule(second, 1000));
    act(() => { jest.advanceTimersByTime(1000); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('never fires after unmount', () => {
    const close = jest.fn<AnyFn>();
    const { result, unmount } = renderHook(() => useAutoCloseTimer());
    act(() => result.current.schedule(close, 1000));
    unmount();
    act(() => { jest.advanceTimersByTime(5000); });
    expect(close).not.toHaveBeenCalled();
  });
});
