// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

/** How many frames to wait for a hash target that a tab has yet to render. */
const HASH_SCROLL_FRAMES = 30;

interface UrlTabOptions<T extends string> {
  /**
   * Element id → the tab that renders it, so `#passkeys` opens the Factors tab
   * even when the link names no `?tab=`. Every enrolment prompt in the app links
   * to a SECTION; without this the link lands on whichever tab happened to be
   * the default and the section it promised isn't on screen.
   */
  hashTabs?: Readonly<Record<string, T>>;
}

/**
 * Tab state that lives in the URL query string.
 *
 * Without this, a tab is invisible to the address bar: the view can't be linked
 * or bookmarked, a refresh drops the user back on the first tab, and browser
 * Back leaves the page entirely instead of returning to the previous tab. The
 * billing/reports/settings pages already hand-rolled this; the compliance
 * dashboard and the reports sub-tabs are what it was extracted for.
 *
 * Updates are `shallow`, so switching tabs never re-runs data fetching for the
 * route — each tab component owns its own fetch.
 *
 * THE HASH IS PART OF THE ADDRESS. A deep link like
 * `/dashboard/security?tab=factors#passkeys` names both a tab and a section on
 * it. Two things work against it: a write-back that drops the fragment, and
 * the browser's own "scroll to #passkeys", which fires before the tab's content
 * has mounted and so scrolls nowhere. Both are handled here — the fragment
 * is carried (and deliberately dropped when the user leaves the tab it belongs
 * to), and the scroll is retried until the section exists.
 *
 * @param key   Query-string key (e.g. `tab`, `sub`).
 * @param valid Accepted values; anything else in the URL is ignored, so a
 *              hand-edited or stale link can't put the UI in an unknown state.
 * @param fallback Value used until/unless the URL names a valid one.
 * @param options `hashTabs` — which tab owns which anchor (see above).
 */
export function useUrlTab<T extends string>(
  key: string,
  valid: readonly T[],
  fallback: T,
  options?: UrlTabOptions<T>,
): [T, (value: T) => void] {
  const router = useRouter();
  const [tab, setTab] = useState<T>(fallback);

  const raw = router.query[key];
  const fromUrl = Array.isArray(raw) ? raw[0] : raw;

  // Held in a ref so an inline `{ hashTabs: {...} }` literal doesn't re-run the
  // effects on every render (same reasoning as `valid` below).
  const hashTabsRef = useRef(options?.hashTabs);
  hashTabsRef.current = options?.hashTabs;

  // URL → state, including browser back/forward.
  useEffect(() => {
    if (!router.isReady) return;
    if (fromUrl && (valid as readonly string[]).includes(fromUrl)) {
      setTab((prev) => (prev === fromUrl ? prev : (fromUrl as T)));
      return;
    }
    // No (valid) tab named, but the fragment may name a section — open the tab
    // that actually renders it rather than the fallback.
    const id = currentHashId();
    const owner = id ? hashTabsRef.current?.[id] : undefined;
    if (owner) setTab((prev) => (prev === owner ? prev : owner));
    // `valid` is static config; depending on the array identity would re-run
    // this on every render for callers passing an inline literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `valid` is static config; its array identity would re-run this every render
  }, [router.isReady, fromUrl]);

  // Land on the section the fragment names. The browser's own fragment scroll
  // has already fired by now (against a tab that hadn't rendered yet), so this
  // re-does it once the element exists — retrying for a few frames to cover the
  // section's own async load, and focusing it so keyboard users arrive there too.
  useEffect(() => {
    if (!router.isReady || typeof window === 'undefined') return;
    const id = currentHashId();
    if (!id) return;
    let frames = 0;
    let raf = 0;
    const land = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        // `focus()` is a no-op unless the target is focusable; sections that are
        // link destinations carry `tabIndex={-1}` for exactly this.
        el.focus?.({ preventScroll: true });
        return;
      }
      if (frames++ < HASH_SCROLL_FRAMES) raf = requestAnimationFrame(land);
    };
    raf = requestAnimationFrame(land);
    return () => cancelAnimationFrame(raf);
  }, [router.isReady, tab]);

  // state → URL.
  const select = useCallback((value: T) => {
    setTab(value);
    // A fragment names a section, and a section lives on ONE tab: keep it while
    // the user stays on that tab, drop it when they leave — otherwise it points
    // at content the new tab doesn't render and re-fires the scroll above.
    const id = currentHashId();
    const hash = id && hashTabsRef.current?.[id] === value ? `#${id}` : '';
    void router.replace({ query: { ...router.query, [key]: value }, hash }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router identity changes each render
  }, [key, router.query]);

  return [tab, select];
}

/** The current fragment without its `#`, or '' (also '' during SSR). */
function currentHashId(): string {
  if (typeof window === 'undefined') return '';
  return decodeURIComponent(window.location.hash.replace(/^#/, ''));
}
