// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * A ref that is `true` once the component has unmounted, for long-running async
 * work (streams, AI generation) to check before touching state.
 *
 * It RESETS to `false` on every mount. The hand-rolled version this replaces —
 * `useEffect(() => () => { ref.current = true }, [])` — only ever set it.
 * Under React StrictMode (`reactStrictMode: true` in next.config.js), dev runs
 * each effect's mount → cleanup → mount, so that ref was already `true` by the
 * time the user did anything: every stream broke out on its first event, the
 * reply stayed in its streaming state and `busy`/`generating` never cleared.
 * Ask, generate-from-prompt and generate-from-Git-URL were all unusable in
 * `next dev`. Production was unaffected, which is why it went unnoticed.
 */
export function useUnmountedRef(): MutableRefObject<boolean> {
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => { unmounted.current = true; };
  }, []);
  return unmounted;
}
