// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Below Tailwind's `lg` breakpoint (1024px) — where split views such as the
 * inbox's list + thread stop fitting side by side and show one pane at a time.
 * Kept in step with the `lg:` classes that lay those views out.
 */
export const BELOW_LG = '(max-width: 1023.98px)';

/** Below Tailwind's `sm` breakpoint (640px) — a phone held upright. */
export const BELOW_SM = '(max-width: 639.98px)';

/**
 * A 44×44px minimum hit area on phones (below `sm`), the touch-target size the
 * platform guidelines ask for; desktop keeps the compact size. Append to an
 * icon or small action button's classes.
 */
export const TAP_TARGET = 'max-sm:min-h-11 max-sm:min-w-11 max-sm:inline-flex max-sm:items-center max-sm:justify-center';

/**
 * Whether a CSS media query matches, tracking changes (rotation, resizing).
 *
 * Reads `false` on the server and wherever `matchMedia` is missing (jsdom), so
 * the first paint is the desktop layout and CSS breakpoints have to carry the
 * small-screen first paint; use this only where layout needs to change what is
 * RENDERED (or where focus has to follow it), not to style.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, read, () => false);
}
