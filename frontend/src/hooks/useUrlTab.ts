// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';

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
 * @param key   Query-string key (e.g. `tab`, `sub`).
 * @param valid Accepted values; anything else in the URL is ignored, so a
 *              hand-edited or stale link can't put the UI in an unknown state.
 * @param fallback Value used until/unless the URL names a valid one.
 */
export function useUrlTab<T extends string>(
  key: string,
  valid: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const router = useRouter();
  const [tab, setTab] = useState<T>(fallback);

  const raw = router.query[key];
  const fromUrl = Array.isArray(raw) ? raw[0] : raw;

  // URL → state, including browser back/forward.
  useEffect(() => {
    if (!router.isReady) return;
    if (fromUrl && (valid as readonly string[]).includes(fromUrl)) {
      setTab((prev) => (prev === fromUrl ? prev : (fromUrl as T)));
    }
    // `valid` is static config; depending on the array identity would re-run
    // this on every render for callers passing an inline literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, fromUrl]);

  // state → URL.
  const select = useCallback((value: T) => {
    setTab(value);
    void router.replace({ query: { ...router.query, [key]: value } }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router identity changes each render
  }, [key, router.query]);

  return [tab, select];
}
