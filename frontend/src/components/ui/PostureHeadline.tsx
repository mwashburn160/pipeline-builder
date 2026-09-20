import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Shared tone palette for the "posture" surfaces (border + bg + text per
 * severity). Worst-signal-wins compute stays in each page; this is presentation
 * only. Canonical source — previously copied verbatim into executions/compliance.
 */
const POSTURE_TONE: Record<'red' | 'yellow' | 'green' | 'gray', string> = {
  red: 'border-danger-border bg-danger-bg text-danger-strong',
  yellow: 'border-warning-border bg-warning-bg text-warning-strong',
  green: 'border-success-border bg-success-bg text-success-strong',
  gray: 'border-default bg-surface-muted text-fg-muted',
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
          <div className="text-2xs uppercase tracking-wide opacity-70 mt-1">{rateLabel}</div>
        </div>
      )}
    </div>
  );
}
