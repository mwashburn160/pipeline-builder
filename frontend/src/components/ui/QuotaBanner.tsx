// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, AlertOctagon, Info, X } from 'lucide-react';
import api from '@/lib/api';
import { highestPressure, type QuotaPressure, type QuotaPressureLevel } from '@/lib/quota-pressure';
import type { OrgQuotaResponse } from '@/types';

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
    container: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-300 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200',
    Icon: Info,
    cta: 'View quotas',
    href: '/dashboard/quotas',
  },
  warning: {
    container: 'bg-orange-50 dark:bg-orange-900/20 border-orange-300 dark:border-orange-800 text-orange-800 dark:text-orange-200',
    Icon: AlertTriangle,
    cta: 'Upgrade tier',
    href: '/dashboard/billing',
  },
  critical: {
    container: 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800 text-red-800 dark:text-red-200',
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

export function QuotaBanner() {
  const [quota, setQuota] = useState<OrgQuotaResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let mounted = true;
    const fetch = async () => {
      try {
        const result = await api.getOwnQuotas();
        if (!mounted) return;
        const q = result.data?.quota ?? null;
        setQuota(q);
        if (q) {
          setDismissed(sessionStorage.getItem(dismissKey(q)) === '1');
        }
      } catch {
        // Quota service unavailable — render nothing.
      }
    };
    fetch();
    const interval = setInterval(fetch, REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const pressure = highestPressure(quota);
  if (pressure.level === 'none' || dismissed || !quota) return null;

  const style = STYLES[pressure.level];
  const { Icon } = style;

  return (
    <div className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${style.container}`} role="alert">
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
          sessionStorage.setItem(dismissKey(quota), '1');
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
