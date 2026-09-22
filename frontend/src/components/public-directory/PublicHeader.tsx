// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Header for the public (signed-out-capable) pages: sign-in is always one click
 * away.
 *
 * The server always renders the GUEST variant — Sign in / Create account — so
 * the SSR HTML is identical for everyone and can be CDN-cached. Only after mount
 * does a signed-in viewer's header swap to "Open app" and their avatar.
 *
 * "Sign in" is `/login?returnTo=<this path + query>`, so every sign-in method
 * lands back on the same plugin or search through the one return-to mechanism.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { Moon, Sun } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useDarkMode } from '@/hooks/useDarkMode';
import { loginHref } from '@/lib/public-directory/links';

/** True once mounted in the browser (so auth-dependent UI never reaches the SSR HTML). */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted;
}

/** The viewer's sign-in state, but ONLY after mount — always "guest" during SSR and hydration. */
export function useClientAuth() {
  const mounted = useMounted();
  const { user, isAuthenticated, isInitialized } = useAuth();
  const signedIn = mounted && isInitialized && isAuthenticated && !!user;
  return { mounted, signedIn, user: signedIn ? user : null };
}

export function PublicHeader() {
  const router = useRouter();
  const { mounted, signedIn, user } = useClientAuth();
  const { isDark, toggle } = useDarkMode();
  const returnTo = router.asPath || '/plugins';

  return (
    <header className="sticky top-0 z-40 border-b border-default bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/" className="font-serif text-lg font-bold text-fg" aria-label="Pipeline Builder home">
            Pipeline Builder
          </Link>
          <nav aria-label="Directory">
            <Link href="/plugins" className="text-sm font-medium text-fg-muted hover:text-fg">Plugins</Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggle}
            className="rounded-lg p-2 text-fg-muted transition-colors hover:text-fg"
            aria-label="Dark mode"
            // A toggle's state is part of its name: without it a screen reader
            // hears the same "button" whichever mode is on. Only after mount —
            // the preference is browser-only, and SSR must not guess it.
            aria-pressed={mounted ? isDark : undefined}
          >
            {/* The icon depends on a browser-only preference: render it after mount. */}
            {mounted && isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          {signedIn && user ? (
            <>
              <Link href="/dashboard" className="btn btn-primary px-3 py-1.5 text-sm">Open app</Link>
              <span
                aria-label={`Signed in as ${user.username || user.email}`}
                title={user.username || user.email}
                className="grid h-8 w-8 place-items-center rounded-full bg-surface-muted text-2xs font-semibold uppercase text-fg-muted"
              >
                {(user.username || user.email || '?').slice(0, 2)}
              </span>
            </>
          ) : (
            <>
              <Link href={loginHref(returnTo)} className="px-2 py-1.5 text-sm font-medium text-fg-muted hover:text-fg">
                Sign in
              </Link>
              <Link href="/auth/register" className="btn btn-primary px-3 py-1.5 text-sm">Create account</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
