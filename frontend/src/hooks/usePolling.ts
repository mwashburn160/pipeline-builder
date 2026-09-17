// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react';

export interface UsePollingOptions {
  /**
   * Skip ticks while the tab is hidden and run once as soon as it becomes
   * visible again (default true). Background tabs throttle timers anyway and
   * the data would be stale by the time anyone looks at it.
   */
  pauseWhenHidden?: boolean;
  /** Run `fn` once when polling starts, before the first interval (default true). */
  immediate?: boolean;
  /** Polling runs only while this is true (default true). */
  enabled?: boolean;
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState !== 'visible';
}

/**
 * Call `fn` every `intervalMs` while mounted (modelled on
 * useObservabilityResource's polling plumbing).
 *
 * `fn` is read through a ref, so passing an inline closure does not restart the
 * timer; the timer restarts only when `intervalMs`, `enabled` or
 * `pauseWhenHidden` change. An `intervalMs` of 0 or less disables polling.
 */
export function usePolling(
  fn: () => unknown,
  intervalMs: number,
  { pauseWhenHidden = true, immediate = true, enabled = true }: UsePollingOptions = {},
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    const tick = () => {
      if (pauseWhenHidden && isHidden()) return;
      void fnRef.current();
    };

    if (immediate) tick();
    const timer = setInterval(tick, intervalMs);

    const onVisibility = () => {
      if (!isHidden()) tick();
    };
    if (pauseWhenHidden) document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(timer);
      if (pauseWhenHidden) document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled, pauseWhenHidden, immediate]);
}
