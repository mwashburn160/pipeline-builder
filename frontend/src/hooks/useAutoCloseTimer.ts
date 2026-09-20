// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef } from 'react';

/**
 * A single pending "close this in a moment" timer.
 *
 * Editors that auto-dismiss after a successful save hold the modal open briefly
 * so the success message is readable. The timer has to be tracked so it can't
 * fire after unmount, and so re-opening the editor CANCELS a close scheduled
 * for the previous subject — otherwise a close queued for one record shuts the
 * editor someone has since opened on another.
 *
 * `schedule` replaces any pending timer; `cancel` drops it. Both are stable.
 */
export function useAutoCloseTimer() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      fn();
    }, ms);
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  return { schedule, cancel };
}
