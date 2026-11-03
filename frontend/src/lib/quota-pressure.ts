// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { OrgQuotaResponse, QuotaSummary, QuotaType } from '@/types';
import { QUOTA_CATALOG } from '@pipeline-builder/api-core/quota-catalog';
import { QUOTA_CRITICAL_THRESHOLD, QUOTA_WARNING_THRESHOLD } from './constants';
import { pct } from './quota-helpers';

/** Banner severity levels driven by the highest quota in pressure. */
export type QuotaPressureLevel = 'none' | 'info' | 'warning' | 'critical';

export interface QuotaPressure {
  level: QuotaPressureLevel;
  /** The most-pressured quota type (e.g. "apiCalls"). Undefined when level==='none'. */
  type?: QuotaType;
  /** Usage percentage (0-100, capped). Undefined when level==='none'. */
  percent?: number;
  /** Human-readable label for the type. */
  label?: string;
}

/**
 * Human label for every quota dimension — a projection of api-core's quota
 * catalog, not a second list.
 *
 * The PLURAL form, because every consumer names a dimension rather than
 * addressing one unit: an at-risk list, a breakdown picker, a banner's
 * "API calls usage at 95%". The singular (`quotaLabel`) belongs to the 429
 * bodies, which address a single denied call.
 *
 * It used to be a hand-maintained map, and the reason it existed is worth
 * keeping: `highestPressure` scans EVERY quota on the response, and so do the
 * quota service's at-risk endpoints, so a partial map left the newer kinds
 * unlabelled (the sysadmin banner printed the raw `storageBytes` / `idpConfigs`
 * keys for exactly that reason). Deriving it from the catalog makes that
 * impossible: a quota type cannot exist without a label.
 */
export const QUOTA_TYPE_LABEL: Record<QuotaType, string> = Object.fromEntries(
  (Object.keys(QUOTA_CATALOG) as QuotaType[]).map((t) => [t, QUOTA_CATALOG[t].labelPlural]),
) as Record<QuotaType, string>;

/** Compute the usage percentage for a single quota (0 for unlimited). */
function quotaPercent(q: QuotaSummary): number {
  if (q.unlimited) return 0;
  return pct(q.used, q.limit);
}

/**
 * Map a percentage to a pressure level. Thresholds are shared with the
 * dashboard status badge via `QUOTA_*_THRESHOLD` constants so the two
 * surfaces can't drift apart.
 *  - >= 100                       → critical (over quota)
 *  - >= QUOTA_CRITICAL_THRESHOLD  → warning  (badge: Critical)
 *  - >= QUOTA_WARNING_THRESHOLD   → info     (badge: Warning)
 *  - else                         → none     (badge: Healthy)
 */
function pressureLevel(percent: number): QuotaPressureLevel {
  if (percent >= 100) return 'critical';
  if (percent >= QUOTA_CRITICAL_THRESHOLD) return 'warning';
  if (percent >= QUOTA_WARNING_THRESHOLD) return 'info';
  return 'none';
}

/** Find the single quota under most pressure across an org's quota response. */
export function highestPressure(response: OrgQuotaResponse | undefined | null): QuotaPressure {
  if (!response?.quotas) return { level: 'none' };
  let best: QuotaPressure = { level: 'none' };
  for (const [type, summary] of Object.entries(response.quotas) as Array<[QuotaType, QuotaSummary]>) {
    const usedPct = quotaPercent(summary);
    const lvl = pressureLevel(usedPct);
    if (lvl === 'none') continue;
    if (best.level === 'none' || usedPct > (best.percent ?? 0)) {
      best = { level: lvl, type, percent: usedPct, label: QUOTA_TYPE_LABEL[type] };
    }
  }
  return best;
}
