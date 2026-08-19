import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Shared tone palette for the "posture" surfaces (border + bg + text per
 * severity). Worst-signal-wins compute stays in each page; this is presentation
 * only. Canonical source — previously copied verbatim into executions/compliance.
 */
export const POSTURE_TONE: Record<'red' | 'yellow' | 'green' | 'gray', string> = {
  red: 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  yellow: 'border-yellow-300 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300',
  green: 'border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300',
  gray: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 text-gray-600 dark:text-gray-300',
};

export interface PostureHeadlineProps {
  tone: 'red' | 'yellow' | 'green' | 'gray';
  Icon: LucideIcon;
  title: ReactNode;
  detail: ReactNode;
  /** Optional big right-side metric (e.g. a pass-rate %). Omit to hide it. */
  rate?: number;
  rateLabel?: string;
  className?: string;
}

/**
 * The "are we healthy?" headline banner: a toned card with an icon + title +
 * detail on the left and an optional large metric on the right.
 */
export function PostureHeadline({ tone, Icon, title, detail, rate, rateLabel = 'passing', className = '' }: PostureHeadlineProps) {
  return (
    <div className={`flex items-center justify-between gap-4 rounded-lg border p-4 ${POSTURE_TONE[tone]} ${className}`}>
      <div className="flex items-center gap-3 min-w-0">
        <Icon className="h-6 w-6 shrink-0" />
        <div className="min-w-0">
          <div className="text-base font-semibold">{title}</div>
          <div className="text-xs opacity-80">{detail}</div>
        </div>
      </div>
      {rate !== undefined && (
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold tabular-nums leading-none">{rate}%</div>
          <div className="text-[11px] uppercase tracking-wide opacity-70 mt-1">{rateLabel}</div>
        </div>
      )}
    </div>
  );
}
