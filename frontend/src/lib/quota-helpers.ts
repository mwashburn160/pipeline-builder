// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { QUOTA_CRITICAL_THRESHOLD, QUOTA_WARNING_THRESHOLD } from './constants';

export function pct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
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

