// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, AlertOctagon, Info, X } from 'lucide-react';
import api from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { usePolling } from '@/hooks/usePolling';
import { useNotificationPrefs } from '@/lib/notification-prefs';
import { highestPressure, type QuotaPressure, type QuotaPressureLevel } from '@/lib/quota-pressure';
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

const MESSAGE: Record<Exclude<QuotaPressureLevel, 'none'>, (p: QuotaPressure) => string> = {
  info: (p) => `${p.label} usage at ${p.percent}% of your monthly limit.`,
  warning: (p) => `${p.label} usage at ${p.percent}% — you'll hit the limit soon.`,
  critical: (p) => `${p.label} quota exceeded (${p.percent}%). New requests will be rejected until reset.`,
};

/** Build a stable session-storage key per (orgId, monthlyResetAt). */
function dismissKey(quota: OrgQuotaResponse): string {
  // Use the apiCalls reset time as the monthly window marker (all reset together).
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
      <span className="flex-1">{MESSAGE[pressure.level](pressure)}</span>
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
