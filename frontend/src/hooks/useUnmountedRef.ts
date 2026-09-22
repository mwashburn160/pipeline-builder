// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * A ref that is `true` once the component has unmounted, for long-running async
 * work (streams, AI generation) to check before touching state.
 *
 * It RESETS to `false` on every mount. Under React StrictMode
 * (`reactStrictMode: true` in next.config.js), dev runs each effect's mount →
 * cleanup → mount, so a ref that is only ever SET would already be `true` by
 * the time the user did anything — every stream would break out on its first
 * event.
 */
export function useUnmountedRef(): MutableRefObject<boolean> {
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => { unmounted.current = true; };
  }, []);
  return unmounted;
}
