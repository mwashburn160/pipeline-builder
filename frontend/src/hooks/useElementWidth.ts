// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useRef, useState } from 'react';

/**
 * Track an element's width with a ResizeObserver, attached through a CALLBACK
 * ref so it follows the element's actual lifetime.
 *
 * The dashboard pages used `useRef` + a mount-only effect. On mount they are
 * still rendering `<LoadingPage/>`, so the ref was null, the effect returned
 * early, and it never ran again once the grid mounted: every dashboard rendered
 * at a fixed 960px — sideways scrolling on a phone, a narrow strip on a wide
 * monitor, and no response to resizes or the sidebar toggle. A callback ref
 * fires when the node appears (and again if it is replaced), whenever that is.
 */
export function useElementWidth(initial: number, min = 320): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(initial);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const measure = () => setWidth(Math.max(min, el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observerRef.current = ro;
  }, [min]);

  return [ref, width];
}
