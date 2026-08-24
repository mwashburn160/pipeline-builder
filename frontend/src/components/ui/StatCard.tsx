// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * `detailed` — the DORA-style layout (muted small-caps label + optional badge on top, big value, sub line).
 */
type StatCardProps = StatCardBaseProps &
  (
    | {
        variant: 'detailed';
        sub?: ReactNode;
        badge?: ReactNode;
      }
    | { variant?: 'centered'; sub?: never; badge?: never }
  );

const TILE = 'rounded-2xl border border-[var(--pb-border)] bg-[var(--pb-surface)] px-4 py-4';

/**
 * Shared presentational metric tile. Token-driven (`--pb-*`, dark-mode correct).
 * `centered` — report summary rows; `detailed` — DORA / retention cards. The
 * canonical home is here in `ui/`; `reports/StatCard` re-exports it.
 */
export function StatCard({
  label, value, sub, badge, variant = 'centered', className = '', wrapperProps,
}: StatCardProps) {
  if (variant === 'centered') {
    return (
      <div className={[TILE, 'text-center', className].filter(Boolean).join(' ')} {...wrapperProps}>
        <p className="text-2xl font-bold tabular-nums text-[var(--pb-text)]">{value}</p>
        <p className="mt-1 text-xs text-[var(--pb-text-muted)]">{label}</p>
      </div>
    );
  }
  return (
    <div className={[TILE, 'w-full', className].filter(Boolean).join(' ')} {...wrapperProps}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--pb-text-muted)]">{label}</p>
        {badge}
      </div>
      <p className="mt-1.5 text-2xl font-bold tabular-nums text-[var(--pb-text)]">{value}</p>
      {sub != null && <p className="mt-1 text-xs tabular-nums text-[var(--pb-text-muted)]">{sub}</p>}
    </div>
  );
}
