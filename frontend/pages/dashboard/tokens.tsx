// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The old "API Tokens" page, which is now three tabs of /dashboard/security.
 *
 * It held access keys, a SECOND list of sessions (which contradicted the one in
 * settings), and the decoded current token — and its own copy told the reader
 * that the sessions on it weren't the real ones. Everything moved; this file
 * forwards the addresses people have bookmarked, per old tab, so a saved link
 * lands on the same content rather than a 404. Nothing of the old page survives
 * behind it.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { LoadingPage } from '@/components/ui/Loading';
import { SECURITY_HREF } from '@/lib/security-links';

/** Old `?tab=` → where that content lives now. */
const MOVED_TO: Record<string, string> = {
  tokens: `${SECURITY_HREF}?tab=keys`,
  sessions: `${SECURITY_HREF}?tab=sessions`,
  access: `${SECURITY_HREF}?tab=sessions#current-token`,
};

export default function TokensPageMoved() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    const raw = router.query.tab;
    const tab = Array.isArray(raw) ? raw[0] : raw;
    void router.replace(MOVED_TO[tab ?? ''] ?? MOVED_TO.tokens);
  }, [router.isReady, router.query.tab, router]);

  return <LoadingPage />;
}
