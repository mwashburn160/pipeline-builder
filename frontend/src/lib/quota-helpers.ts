import { formatBytes, fmtNum } from '@/lib/format';
import { quotaRender } from '@pipeline-builder/api-core/quota-catalog';
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { QUOTA_CRITICAL_THRESHOLD, QUOTA_WARNING_THRESHOLD } from './constants';

/**
 * Usage as a whole percentage, capped at 100. 100 means AT OR OVER the limit
 * and nothing else: rounding alone turned 995/1000 into 100, and the banner
 * keyed on 100 told the org new requests "will be rejected" with 5 left.
 */
export function pct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  if (used >= limit) return 100;
  return Math.min(99, Math.round((used / limit) * 100));
}

export function daysUntil(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const d = Math.ceil((ms - Date.now()) / 864e5);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  return `${d}d`;
}

export type StatusColor = 'green' | 'yellow' | 'red' | 'purple';

export function statusInfo(used: number, limit: number): { label: string; color: StatusColor } {
  if (limit === -1) return { label: 'Unlimited', color: 'purple' };
  const p = pct(used, limit);
  if (p >= QUOTA_CRITICAL_THRESHOLD) return { label: 'Critical', color: 'red' };
  if (p >= QUOTA_WARNING_THRESHOLD) return { label: 'Warning', color: 'yellow' };
  return { label: 'Healthy', color: 'green' };
}

export const statusStyles: Record<StatusColor, string> = {
  green: 'bg-success-bg text-success-strong',
  yellow: 'bg-warning-bg text-warning-strong',
  red: 'bg-danger-bg text-danger-strong',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
};

export const barStyles: Record<StatusColor, string> = {
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
  purple: 'bg-blue-500',
};

export function overallHealthColor(quotas: Record<string, { used: number; limit: number }>): string {
  let worst = 0;
  for (const q of Object.values(quotas)) {
    if (q.limit === -1) continue;
    worst = Math.max(worst, pct(q.used, q.limit));
  }
  if (worst >= QUOTA_CRITICAL_THRESHOLD) return 'bg-red-500';
  if (worst >= QUOTA_WARNING_THRESHOLD) return 'bg-yellow-500';
  return 'bg-green-500';
}

/**
 * Format a raw quota value for display, by the type's own render mode.
 *
 * EXHAUSTIVE on purpose: the `switch` has no default, so adding a member to
 * api-core's `QuotaRender` stops this compiling until it is handled here. A
 * boolean "is it bytes?" check would instead have rendered the new mode as a
 * plain count, silently — which is the failure the quota catalog exists to
 * prevent, and which it would have reproduced in its own accessors.
 */
export function formatQuotaValue(type: string, value: number): string {
  const render = quotaRender(type);
  switch (render) {
    case 'bytes':
      return formatBytes(value);
    case 'count':
      return fmtNum(value);
  }
}
