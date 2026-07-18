// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useUnsavedChangesWarning — the guard that warns before discarding
 * unsaved draft work.
 *
 * Covers: no handlers when clean; beforeunload prevented + routeChangeStart
 * registered when dirty; routeChangeStart aborts (throws) when the user
 * cancels the confirm and passes through when confirmed; allowNavigation()
 * bypasses the guard for an intentional (post-save) navigation; teardown when
 * dirty flips back to false.
 */

import { act, renderHook } from '@testing-library/react';

// A controllable stand-in for Next.js's router.events mitt emitter.
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const events = {
  on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb);
  }),
  off: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    listeners.get(event)?.delete(cb);
  }),
  emit: jest.fn(),
};

function emitRouteChangeStart(url: string) {
  // Mirror the router: invoke each registered routeChangeStart listener,
  // letting a thrown abort propagate to the caller.
  for (const cb of listeners.get('routeChangeStart') ?? []) cb(url);
}

jest.mock('next/router', () => ({
  useRouter: () => ({ events }),
}));

import { useUnsavedChangesWarning } from '../src/hooks/useUnsavedChangesWarning';

function fireBeforeUnload(): boolean {
  const evt = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(evt);
  return evt.defaultPrevented;
}

describe('useUnsavedChangesWarning', () => {
  afterEach(() => {
    listeners.clear();
  });

  it('registers no guards when not dirty', () => {
    renderHook(() => useUnsavedChangesWarning(false));
    expect(events.on).not.toHaveBeenCalledWith('routeChangeStart', expect.any(Function));
    expect(fireBeforeUnload()).toBe(false); // nothing prevents unload
  });

  it('prevents beforeunload and guards route changes when dirty', () => {
    renderHook(() => useUnsavedChangesWarning(true));
    expect(events.on).toHaveBeenCalledWith('routeChangeStart', expect.any(Function));
    expect(fireBeforeUnload()).toBe(true);
  });

  it('aborts the route change when the user cancels the confirm', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    renderHook(() => useUnsavedChangesWarning(true));

    expect(() => emitRouteChangeStart('/somewhere')).toThrow();
    expect(events.emit).toHaveBeenCalledWith('routeChangeError');

    confirmSpy.mockRestore();
  });

  it('allows the route change when the user confirms', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    renderHook(() => useUnsavedChangesWarning(true));

    expect(() => emitRouteChangeStart('/somewhere')).not.toThrow();

    confirmSpy.mockRestore();
  });

  it('allowNavigation() bypasses the guard without prompting', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    const { result } = renderHook(() => useUnsavedChangesWarning(true));

    act(() => {
      result.current(); // allowNavigation()
    });

    expect(() => emitRouteChangeStart('/after-save')).not.toThrow();
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('tears down guards when dirty flips back to false', () => {
    const { rerender } = renderHook(({ dirty }) => useUnsavedChangesWarning(dirty), {
      initialProps: { dirty: true },
    });
    expect(fireBeforeUnload()).toBe(true);

    rerender({ dirty: false });
    expect(events.off).toHaveBeenCalledWith('routeChangeStart', expect.any(Function));
    expect(fireBeforeUnload()).toBe(false);
  });
});
