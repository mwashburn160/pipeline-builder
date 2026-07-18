// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

/**
 * Surfaces `AuthContext.authError` — set when a profile refresh fails for a
 * transient reason (network / 5xx) rather than a genuine 401. The prior user
 * is kept by design, so without this banner a possibly-stale session showed
 * no signal or retry path.
 *
 * Mounts once in the shared DashboardLayout banner strip (next to the quota /
 * impersonation banners). "Retry" re-runs `refreshUser`, which clears
 * `authError` on success — so a recovered session hides the banner
 * automatically. A local dismiss hides it until the next distinct failure.
 */
export function AuthErrorBanner() {
  const { authError, refreshUser } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // A fresh failure (new Error identity) re-shows a previously dismissed banner.
  useEffect(() => {
    if (authError) setDismissed(false);
  }, [authError]);

  if (!authError || dismissed) return null;

  const retry = async () => {
    setRetrying(true);
    try {
      // On success refreshUser() clears authError → this unmounts. On another
      // transient failure a new Error is set → banner stays (dismissed reset).
      await refreshUser();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      className="flex items-center gap-3 border-b border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-2 text-sm text-amber-800 dark:text-amber-200"
      role="alert"
    >
      <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span className="flex-1">
        We couldn&apos;t refresh your session — you may be seeing out-of-date account info.
      </span>
      <button
        type="button"
        onClick={() => void retry()}
        disabled={retrying}
        className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:no-underline disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} aria-hidden="true" />
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
        aria-label="Dismiss session warning"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
