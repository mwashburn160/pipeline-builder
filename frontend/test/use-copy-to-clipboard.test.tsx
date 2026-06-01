// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useCopyToClipboard — the clipboard-write hook with auto-reset
 * feedback state that consolidates the duplicated state machine across
 * CopyButton and CopyableId.
 *
 * Covers: idle → copied → idle transition, failed state on Clipboard
 * rejection, and timer cleanup on unmount (no stale state writes).
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useCopyToClipboard } from '../src/hooks/useCopyToClipboard';

// jsdom doesn't ship navigator.clipboard — swap in a per-test mock
function mockClipboard(impl: { writeText: (text: string) => Promise<void> }) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: impl,
  });
}

describe('useCopyToClipboard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useCopyToClipboard());
    expect(result.current.state).toBe('idle');
  });

  it('transitions idle → copied → idle after timer', async () => {
    mockClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });

    const { result } = renderHook(() => useCopyToClipboard(1500));

    await act(async () => {
      await result.current.copy('hello');
    });

    expect(result.current.state).toBe('copied');

    // Advance past the reset timer
    act(() => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(result.current.state).toBe('idle'));
  });

  it('passes the value through to clipboard.writeText', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    mockClipboard({ writeText });

    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('payload-x');
    });

    expect(writeText).toHaveBeenCalledWith('payload-x');
  });

  it('goes to failed state when clipboard API rejects', async () => {
    mockClipboard({ writeText: jest.fn().mockRejectedValue(new Error('blocked')) });

    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('x');
    });

    expect(result.current.state).toBe('failed');
  });

  it('resets to idle after a failed copy', async () => {
    mockClipboard({ writeText: jest.fn().mockRejectedValue(new Error('blocked')) });

    const { result } = renderHook(() => useCopyToClipboard(500));

    await act(async () => {
      await result.current.copy('x');
    });
    expect(result.current.state).toBe('failed');

    act(() => {
      jest.advanceTimersByTime(500);
    });

    await waitFor(() => expect(result.current.state).toBe('idle'));
  });

  it('clears pending timer on unmount', async () => {
    mockClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });

    const { result, unmount } = renderHook(() => useCopyToClipboard(1500));

    await act(async () => {
      await result.current.copy('x');
    });
    expect(result.current.state).toBe('copied');

    const clearSpy = jest.spyOn(global, 'clearTimeout');
    unmount();
    // Cleanup runs clearTimer, which calls clearTimeout
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('rapid clicks reset the timer (no stale "copied")', async () => {
    mockClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });

    const { result } = renderHook(() => useCopyToClipboard(1000));

    await act(async () => {
      await result.current.copy('a');
    });
    // Advance halfway
    act(() => { jest.advanceTimersByTime(500); });
    expect(result.current.state).toBe('copied');

    // Second copy resets the timer — should still be copied after another 500ms
    await act(async () => {
      await result.current.copy('b');
    });
    act(() => { jest.advanceTimersByTime(500); });
    expect(result.current.state).toBe('copied');

    // Full timer length from the second copy
    act(() => { jest.advanceTimersByTime(500); });
    await waitFor(() => expect(result.current.state).toBe('idle'));
  });
});
