// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { OrgQuotaResponse, QuotaSummary, QuotaType } from '@/types';
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

const TYPE_LABEL: Record<QuotaType, string> = {
  plugins: 'Plugins',
  pipelines: 'Pipelines',
  apiCalls: 'API calls',
  aiCalls: 'AI calls',
};

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
    const pct = quotaPercent(summary);
    const lvl = pressureLevel(pct);
    if (lvl === 'none') continue;
    if (best.level === 'none' || pct > (best.percent ?? 0)) {
      best = { level: lvl, type, percent: pct, label: TYPE_LABEL[type] };
    }
  }
  return best;
}
