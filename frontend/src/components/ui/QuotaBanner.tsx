// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, AlertOctagon, Info, X } from 'lucide-react';
import api from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { usePolling } from '@/hooks/usePolling';
import { useNotificationPrefs } from '@/lib/notification-prefs';
import { highestPressure, QUOTA_TYPE_LABEL, type QuotaPressure, type QuotaPressureLevel } from '@/lib/quota-pressure';
import type { OrgQuotaResponse } from '@/types';
import { useUnmountedRef } from '@/hooks/useUnmountedRef';

const REFRESH_MS = 60_000; // 60s freshness window
const DISMISS_KEY = 'quotaBannerDismissed';

interface BannerStyle {
  /** Container classes for background + border. */
  container: string;
  /** Icon component. */
  Icon: typeof Info;
  /** CTA copy. */
  cta: string;
  /** CTA href. */
  href: string;
}

const STYLES: Record<Exclude<QuotaPressureLevel, 'none'>, BannerStyle> = {
  info: {
    container: 'bg-warning-bg border-warning-border text-warning-strong',
    Icon: Info,
    cta: 'View quotas',
    href: '/dashboard/quotas',
  },
  warning: {
    container: 'bg-warning-bg border-warning-border text-warning-strong',
    Icon: AlertTriangle,
    cta: 'Upgrade tier',
    href: '/dashboard/billing',
  },
  critical: {
    container: 'bg-danger-bg border-danger-border text-danger-strong',
    Icon: AlertOctagon,
    cta: 'Upgrade tier',
    href: '/dashboard/billing',
  },
};

/**
 * "this 3-day period" — the period of the quota being described, which is PER
 * TYPE: the global window for every flow quota but `cpuCredits`, which is
 * monthly. An earlier version read the ORG-level figure, which was right only
 * while every quota shared one window; headlining credits with it would describe
 * a monthly limit as a three-day one.
 *
 * A monthly window reads as "monthly" rather than "30-day", because the phrase
 * is what tells a reader this dimension does not share the others'.
 */
function periodPhrase(periodDays: number | undefined): string {
  if (!periodDays) return 'this period\'s limit';
  if (periodDays >= 28 && periodDays <= 31) return 'this month\'s limit';
  return `this ${periodDays}-day period's limit`;
}

const MESSAGE: Record<Exclude<QuotaPressureLevel, 'none'>, (p: QuotaPressure, periodDays?: number) => string> = {
  info: (p, periodDays) => `${p.label} usage at ${p.percent}% of ${periodPhrase(periodDays)}.`,
  warning: (p) => `${p.label} usage at ${p.percent}% — you'll hit the limit soon.`,
  critical: (p) => `${p.label} quota exceeded (${p.percent}%). New requests will be rejected until reset.`,
};

/** Build a stable session-storage key per (orgId, period). */
function dismissKey(quota: OrgQuotaResponse): string {
  // Use the apiCalls reset time as the period marker (all reset together).
  const reset = quota.quotas.apiCalls?.resetAt ?? '';
  return `${DISMISS_KEY}:${quota.orgId}:${reset}`;
}

interface QuotaBannerProps {
  /** Extra classes appended to the root container. */
  className?: string;
}

export function QuotaBanner({ className = '' }: QuotaBannerProps = {}) {
  const [quota, setQuota] = useState<OrgQuotaResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const unmountedRef = useUnmountedRef();

  const refresh = useCallback(async () => {
    try {
      const result = await api.getOwnQuotas();
      if (unmountedRef.current) return;
      const q = result.data?.quota ?? null;
      setQuota(q);
      if (q) {
        try { setDismissed(sessionStorage.getItem(dismissKey(q)) === '1'); } catch { /* sessionStorage may be unavailable */ }
      }
    } catch {
      // Quota service unavailable — render nothing.
    }
  }, [unmountedRef]);
  // Background tabs skip the poll (the data would be stale anyway) and catch up
  // as soon as the tab is visible again.
  usePolling(refresh, REFRESH_MS, { pauseWhenHidden: true });

  const { user } = useAuth();
  const { muteQuotaWarnings } = useNotificationPrefs(user?.id, user?.organizationId);

  const pressure = highestPressure(quota);
  if (pressure.level === 'none' || dismissed || !quota) return null;
  // Muting silences approaching-limit notices only; an exceeded limit means
  // requests are being rejected, which the user needs to see.
  if (muteQuotaWarnings && pressure.level !== 'critical') return null;

  const style = STYLES[pressure.level];
  const { Icon } = style;

  return (
    <div className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${style.container} ${className}`} role="alert">
      <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      {/* The PRESSURE's period, not the org's: the banner names whichever
          dimension is most pressured, and that dimension's window may not be
          the global one. Falls back to the org figure for responses predating
          the per-type field. */}
      <span className="flex-1">{MESSAGE[pressure.level](pressure, pressure.periodDays ?? quota.periodDays)}</span>
      <Link
        href={style.href}
        className="font-medium underline underline-offset-2 hover:no-underline"
      >
        {style.cta}
      </Link>
      <button
        type="button"
        onClick={() => {
          try { sessionStorage.setItem(dismissKey(quota), '1'); } catch { /* sessionStorage may be unavailable */ }
          setDismissed(true);
        }}
        className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
        aria-label="Dismiss quota notice"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** What a 429 QUOTA_EXCEEDED told us (the `quota-exceeded` window event's detail). */
export interface QuotaExceededDetail {
  message: string;
  quotaType?: string;
  limit?: number;
  used?: number;
  resetAt?: string;
  upgradeUrl?: string;
}

/**
 * Global notice for a refused request: ANY call the api client sees come back
 * 429 `QUOTA_EXCEEDED` dispatches `quota-exceeded`, and this renders which quota
 * ran out, when it resets and the upgrade link — on every page, not just the
 * few forms that used to special-case the code. The page's own toast still
 * carries the server's sentence; this is the persistent, actionable copy.
 */
export function QuotaExceededNotice({ className = '' }: { className?: string } = {}) {
  const [detail, setDetail] = useState<QuotaExceededDetail | null>(null);
  useEffect(() => {
    const handler = (e: Event) => setDetail((e as CustomEvent<QuotaExceededDetail>).detail ?? null);
    window.addEventListener('quota-exceeded', handler);
    return () => window.removeEventListener('quota-exceeded', handler);
  }, []);
  if (!detail) return null;

  const resetMs = detail.resetAt ? Date.parse(detail.resetAt) : NaN;
  // Same-origin paths only: the body is server data, and a link is a link.
  const upgradeHref = detail.upgradeUrl?.startsWith('/') && !detail.upgradeUrl.startsWith('//')
    ? detail.upgradeUrl
    : STYLES.critical.href;
  const label = detail.quotaType && detail.quotaType in QUOTA_TYPE_LABEL
    ? QUOTA_TYPE_LABEL[detail.quotaType as keyof typeof QUOTA_TYPE_LABEL]
    : detail.quotaType;
  return (
    <div className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${STYLES.critical.container} ${className}`} role="alert">
      <AlertOctagon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span className="flex-1">
        {label ? <strong className="font-medium">{label} quota reached. </strong> : null}
        {Number.isFinite(resetMs)
          ? <>Resets {new Date(resetMs).toLocaleString()}.</>
          : detail.message}
        {typeof detail.used === 'number' && typeof detail.limit === 'number'
          ? <span className="tabular-nums"> ({detail.used.toLocaleString()} / {detail.limit.toLocaleString()})</span>
          : null}
      </span>
      <Link href="/dashboard/quotas" className="font-medium underline underline-offset-2 hover:no-underline">
        What used it
      </Link>
      <Link href={upgradeHref} className="font-medium underline underline-offset-2 hover:no-underline">
        {STYLES.critical.cta}
      </Link>
      <button
        type="button"
        onClick={() => setDetail(null)}
        className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
        aria-label="Dismiss quota notice"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
