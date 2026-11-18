// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * A ref that always holds the newest `value`, for code that runs LATER than the
 * render that produced it (a timer, a subscription, a memoised column builder's
 * row handler) and must not act on a stale prop.
 *
 * Updated in a layout effect, not during render: a render that React throws
 * away (a suspended or interrupted concurrent render) must not leak its values
 * into a callback that the committed tree will call.
 *
 * Inside an EFFECT prefer React's own `useEffectEvent`; this is for the cases
 * it does not cover — a callback handed to an event handler, a child, or a
 * `useMemo`'d structure.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * A callback with a STABLE identity that always calls the newest `fn`.
 *
 * For a handler that a memoised structure (table columns, a context value) or a
 * `useCallback` closes over: depending on it never invalidates the memo, and
 * calling it never runs a previous render's closure. Do not call it during
 * render — before the first commit it would see the initial `fn`.
 */
export function useEventCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useLatest(fn);
  return useCallback((...args: A) => latest.current(...args), [latest]);
}

/**
 * `value` as first seen for `key`: the same object back for as long as `key` is
 * unchanged, and the new `value` the render the key changes.
 *
 * For a structural value rebuilt every render (a params / filters object) whose
 * meaning is fully captured by a string key: a hook can then depend on the value
 * itself — honestly, with no lint suppression — without an object-identity
 * change re-running it.
 */
export function useKeyedValue<T>(value: T, key: string): T {
  const [held, setHeld] = useState({ key, value });
  if (held.key !== key) {
    // Adjust-state-during-render: the next render already sees the new pair.
    setHeld({ key, value });
    return value;
  }
  return held.value;
}

/** Element-wise `Object.is` — the comparison React applies to effect deps. */
function sameElements(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * A caller-supplied dependency LIST as one value: the same array back while
 * every element is `Object.is`-equal (React's own dep comparison), a new one
 * the render any element — or the length — changes.
 *
 * For a hook that forwards its caller's `deps` into its own effect: listing
 * the result is statically checkable, where spreading `...deps` into the
 * effect's array is not (and a length change there is a React error).
 */
export function useStableDeps(deps: ReadonlyArray<unknown>): ReadonlyArray<unknown> {
  const [held, setHeld] = useState(deps);
  if (!sameElements(held, deps)) {
    setHeld(deps);
    return deps;
  }
  return held;
}
