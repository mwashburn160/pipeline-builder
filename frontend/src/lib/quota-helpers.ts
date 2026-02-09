export function pct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function fmtNum(n: number): string {
  return n === -1 ? '∞' : n.toLocaleString();
}

export function daysUntil(iso: string): string {
  const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  return `${d}d`;
}

export type StatusColor = 'green' | 'yellow' | 'red' | 'purple';

export function statusInfo(used: number, limit: number): { label: string; color: StatusColor } {
  if (limit === -1) return { label: 'Unlimited', color: 'purple' };
  const p = pct(used, limit);
  if (p >= 90) return { label: 'Critical', color: 'red' };
  if (p >= 70) return { label: 'Warning', color: 'yellow' };
  return { label: 'Healthy', color: 'green' };
}

export const statusStyles: Record<StatusColor, string> = {
  green: 'bg-green-100 text-green-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  red: 'bg-red-100 text-red-800',
  purple: 'bg-purple-100 text-purple-800',
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
  if (worst >= 90) return 'bg-red-500';
  if (worst >= 70) return 'bg-yellow-500';
  return 'bg-green-500';
}

export function barColor(used: number, limit: number, unlimited: boolean): string {
  if (unlimited) return 'bg-blue-500';
  const p = pct(used, limit);
  if (p >= 90) return 'bg-red-500';
  if (p >= 70) return 'bg-yellow-500';
  return 'bg-green-500';
}
