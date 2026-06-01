// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Clipboard-write hook with auto-reset feedback state. Consolidates the
 * identical state machine that CopyButton and CopyableId each implemented
 * separately. Timer is cleared on unmount and on every new copy attempt
 * so rapid clicks don't leave a stale "copied" indicator.
 *
 * @example
 * const { state, copy } = useCopyToClipboard();
 * <button onClick={() => copy('hello')}>{state === 'copied' ? '✓' : 'Copy'}</button>
 */
export function useCopyToClipboard(resetMs = 1500): {
  state: CopyState;
  copy: (value: string) => Promise<void>;
} {
  const [state, setState] = useState<CopyState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const copy = useCallback(
    async (value: string) => {
      clearTimer();
      try {
        await navigator.clipboard.writeText(value);
        setState('copied');
      } catch {
        setState('failed');
      }
      timerRef.current = setTimeout(() => setState('idle'), resetMs);
    },
    [resetMs],
  );

  return { state, copy };
}
