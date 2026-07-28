import type { HTMLAttributes, ReactNode } from 'react';

interface StatCardBaseProps {
  label: ReactNode;
  value: ReactNode;
  /** Extra classes appended to the card wrapper. */
  className?: string;
  /** Extra attributes spread onto the card wrapper (e.g. tabIndex/role/aria for a tooltip trigger). */
  wrapperProps?: HTMLAttributes<HTMLDivElement>;
}

/**
 * Discriminated on `variant` so `sub`/`badge` (detailed-only slots) can't be
 * passed to the centered layout that never renders them.
 *
 * `centered` — the summary-stat layout (big value, muted label beneath it, text-center).
 * `detailed` — the DORA-style layout (muted label + optional badge on top, big value, sub line).
 */
type StatCardProps = StatCardBaseProps &
  (
    | {
        variant: 'detailed';
        /** Detailed variant only: a secondary line rendered beneath the value. */
        sub?: ReactNode;
        /** Detailed variant only: node rendered at the top-right of the header row (e.g. a level badge). */
        badge?: ReactNode;
      }
    | { variant?: 'centered'; sub?: never; badge?: never }
  );

/**
 * Shared presentational stat card used by the report summary rows (centered)
 * and the DORA metric cards (detailed). `StatCardSkeleton` mirrors the centered
 * layout. Kept purely presentational — no data fetching or derived state.
 */
export function StatCard({
  label, value, sub, badge, variant = 'centered', className = '', wrapperProps,
}: StatCardProps) {
  if (variant === 'centered') {
    return (
      <div className={`card py-4 text-center${className ? ` ${className}` : ''}`} {...wrapperProps}>
        <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{label}</p>
      </div>
    );
  }
  return (
    <div className={`card py-4 w-full${className ? ` ${className}` : ''}`} {...wrapperProps}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-gray-400 dark:text-gray-500">{label}</p>
        {badge}
      </div>
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1 tabular-nums">{value}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 tabular-nums">{sub}</p>
    </div>
  );
}
