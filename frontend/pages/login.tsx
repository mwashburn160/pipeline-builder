// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/login?returnTo=<path>` — the stable, bookmarkable sign-in link.
 *
 * It adds no new redirect path: `returnTo` goes through `sanitizeReturnPath`
 * (same-origin, relative, not sign-in machinery — anything else is dropped) into
 * the existing return-to store, and the visitor is sent to `/`, the sign-in
 * page. Every sign-in method (password, MFA, passkey, OAuth, SSO) then lands
 * back on that path through the one return-to mechanism. An unsafe `returnTo`
 * is ignored rather than stored, so `/login` can never become an open redirect.
 */
import { useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { LoadingPage } from '@/components/ui/Loading';
import { rememberReturnPath, sanitizeReturnPath } from '@/lib/return-to';

export default function LoginPage() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    const safe = sanitizeReturnPath(router.query.returnTo);
    if (safe) rememberReturnPath(safe);
    void router.replace('/');
  }, [router, router.isReady]);

  return (
    <>
      <Head>
        <title>Sign in · Pipeline Builder</title>
        <meta name="robots" content="noindex" />
      </Head>
      <LoadingPage message="Taking you to sign in…" />
      <noscript>
        <p className="p-4 text-center">
          <a href="/">Continue to sign in</a>
        </p>
      </noscript>
    </>
  );
}
