// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldAlert, Timer } from 'lucide-react';
import api from '@/lib/api';
import { decodeJwt } from '@/lib/jwt';

/**
 * Banner shown across the dashboard while the sysadmin is in a read-only
 * impersonation session. Renders nothing for normal sessions.
 *
 * Who is being viewed comes from the impersonation token itself (it carries the
 * target's `username`, `email` and `organizationName`, like any access token),
 * so the banner names a person rather than an id. The countdown runs to the
 * token's `exp`: the session is not refreshable, so that is when it ends.
 *
 * NOT sticky itself — `DashboardLayout` stacks it inside the sticky header so
 * the two can never overlap on scroll.
 *
 * "Stop impersonating" restores the original sysadmin tokens, ENDS the session
 * on the server (so the token stops working everywhere, not just in this
 * browser), and reloads to ditch any cached state held under the impersonated
 * identity. The server-side end is best-effort and time-boxed inside
 * `api.endImpersonation` — the operator always gets out.
 */
interface ImpersonationBannerProps {
  /** Extra classes appended to the root container. */
  className?: string;
}

interface ImpersonationTarget {
  name: string | null;
  email: string | null;
  userId: string | null;
  organizationName: string | null;
  /** Token expiry, epoch ms. */
  expiresAt: number | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function readTarget(token: string | null): ImpersonationTarget {
  const payload = token ? decodeJwt(token)?.payload : undefined;
  return {
    name: str(payload?.username),
    email: str(payload?.email),
    userId: str(payload?.sub),
    organizationName: str(payload?.organizationName),
    expiresAt: typeof payload?.exp === 'number' ? payload.exp * 1000 : null,
  };
}

/** `m:ss` (or `h:mm:ss`) left; never negative. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Warn when the session is about to end. */
const ENDING_SOON_MS = 2 * 60 * 1000;

export function ImpersonationBanner({ className = '' }: ImpersonationBannerProps = {}) {
  const impersonating = api.isImpersonating();
  const token = impersonating ? api.getAccessToken() : null;
  const target = useMemo(() => readTarget(token), [token]);
  const requestId = impersonating ? api.getImpersonationRequestId() : null;

  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!impersonating || target.expiresAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [impersonating, target.expiresAt]);

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await api.endImpersonation();
    } finally {
      // Always leave, even if ending on the server failed.
      window.location.href = '/dashboard';
    }
  }, []);

  if (!impersonating) return null;

  const msLeft = target.expiresAt === null ? null : target.expiresAt - now;
  const expired = msLeft !== null && msLeft <= 0;
  const endingSoon = msLeft !== null && !expired && msLeft <= ENDING_SOON_MS;
  const who = target.name ?? target.email ?? target.userId;

  return (
    <div
      role="region"
      aria-label="Impersonation session"
      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-warning-border bg-warning-bg px-4 py-2 text-sm ${className}`}
    >
      <div className="flex min-w-0 items-start gap-2 text-warning-strong">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p>
            <strong>Viewing as {who ?? 'another user'}</strong>
            {target.name && target.email && (
              <span className="ml-1 text-warning-strong">({target.email})</span>
            )}
            {target.organizationName && (
              <span className="ml-1">in <strong>{target.organizationName}</strong></span>
            )}
          </p>
          <p className="text-xs text-warning">
            Read-only — changes are blocked for this session.
            {requestId && (
              <span className="ml-1">
                Request <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">{requestId}</code>
              </span>
            )}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {msLeft !== null && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium tabular-nums ${
              expired || endingSoon ? 'text-danger' : 'text-warning-strong'
            }`}
            data-testid="impersonation-countdown"
            // Announce only the state change, not every tick.
            aria-live="off"
          >
            <Timer className="h-3.5 w-3.5" aria-hidden />
            {expired ? 'Session expired' : `Ends in ${formatCountdown(msLeft)}`}
          </span>
        )}
        <button
          onClick={() => void stop()}
          disabled={stopping}
          className="btn-secondary text-xs"
          aria-label="Stop impersonating and return to sysadmin session"
        >
          {stopping ? 'Ending session…' : 'Stop impersonating'}
        </button>
      </div>
    </div>
  );
}
