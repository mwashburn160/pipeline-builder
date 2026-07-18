// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';

const DEFAULT_MESSAGE = 'You have unsaved changes. Leave without saving?';

/**
 * Guards against losing unsaved draft work. While `dirty` is true it:
 *  - registers a `beforeunload` handler (browser Back / tab close / reload),
 *  - registers a Next.js `routeChangeStart` handler that `confirm()`s and
 *    aborts an in-app navigation (sidebar click, `<Link>`, `router.push`) when
 *    the user declines.
 *
 * Both handlers are torn down as soon as `dirty` flips to false.
 *
 * Aborting a Next.js client route change is done by throwing after emitting
 * `routeChangeError` — the framework-documented cancel pattern. The thrown
 * string surfaces in the console but is swallowed by the router; that is
 * expected, not a bug.
 *
 * Returns `allowNavigation()`: call it immediately before a programmatic
 * navigation that should bypass the guard (e.g. the post-Save redirect) so the
 * guard doesn't prompt on an intentional, already-persisted transition.
 */
export function useUnsavedChangesWarning(dirty: boolean, message: string = DEFAULT_MESSAGE) {
  const router = useRouter();
  // Set true right before an intentional navigation (post-save) so the next
  // routeChangeStart is allowed through without a confirm.
  const bypassRef = useRef(false);

  const allowNavigation = useCallback(() => {
    bypassRef.current = true;
  }, []);

  useEffect(() => {
    if (!dirty) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy Chrome/Firefox require a non-empty returnValue to prompt.
      e.returnValue = message;
      return message;
    };

    const handleRouteChangeStart = (url: string) => {
      if (bypassRef.current) return;
      if (window.confirm(message)) return; // user chose to leave
      // User cancelled — abort the route change (documented Next.js pattern).
      router.events.emit('routeChangeError');
      // eslint-disable-next-line no-throw-literal
      throw `Route change to "${url}" aborted by unsaved-changes guard.`;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    router.events.on('routeChangeStart', handleRouteChangeStart);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      router.events.off('routeChangeStart', handleRouteChangeStart);
    };
  }, [dirty, message, router]);

  return allowNavigation;
}
