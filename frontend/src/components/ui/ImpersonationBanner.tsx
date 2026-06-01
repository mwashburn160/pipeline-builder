// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { ShieldAlert } from 'lucide-react';
import api from '@/lib/api';

/**
 * Sticky banner shown across the dashboard while the sysadmin is in a
 * read-only impersonation session. Renders nothing for normal sessions.
 *
 * "Stop impersonating" restores the original sysadmin tokens stored in
 * sessionStorage by `api.startImpersonation` and reloads to ditch any
 * cached state held under the impersonated identity.
 */
interface ImpersonationBannerProps {
  /** Extra classes appended to the root container. */
  className?: string;
}

export function ImpersonationBanner({ className = '' }: ImpersonationBannerProps = {}) {
  const impersonating = api.isImpersonating();
  const targetId = impersonating ? api.getImpersonatedUserId() : null;

  const stop = useCallback(() => {
    api.stopImpersonation();
    window.location.href = '/dashboard';
  }, []);

  if (!impersonating) return null;

  return (
    <div className={`sticky top-0 z-50 flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm dark:border-amber-700 dark:bg-amber-900/30 ${className}`}>
      <div className="flex items-center gap-2 text-amber-900 dark:text-amber-100">
        <ShieldAlert className="h-4 w-4" />
        <span>
          <strong>Read-only impersonation</strong> active
          {targetId && (
            <span className="ml-1">— viewing as user <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">{targetId}</code></span>
          )}
          <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">(writes are disabled)</span>
        </span>
      </div>
      <button
        onClick={stop}
        className="btn-secondary text-xs"
        aria-label="Stop impersonating and return to sysadmin session"
      >
        Stop impersonating
      </button>
    </div>
  );
}
