// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { HTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';

interface StatCardBaseProps {
  label: ReactNode;
  value: ReactNode;
  /** Extra classes appended to the card wrapper. */
  className?: string;
  /** Extra attributes spread onto the card wrapper (e.g. tabIndex/role/aria for a tooltip trigger). */
  wrapperProps?: HTMLAttributes<HTMLDivElement>;
}

/**
 * Discriminated on `variant` so per-variant slots can't be passed to a layout
 * that never renders them.
 *
 * `centered` — the summary-stat layout (big value, muted label beneath it, text-center).
 * `detailed` — the DORA-style layout (muted small-caps label + optional badge on top, big value, sub line).
 * `nav`      — an icon-leading tile (icon in a soft/accent tile on the left, label + big
 *              value on the right, optional sub); optionally a link. Replaces the
 *              bespoke icon stat-tiles on the sysadmin home + build-queue pages.
 */
type StatCardProps = StatCardBaseProps &
  (
    | {
        variant: 'detailed';
        sub?: ReactNode;
        badge?: ReactNode;
      }
    | { variant?: 'centered'; sub?: never; badge?: never }
    | {
        variant: 'nav';
        /** Leading icon rendered in a tile. */
        icon: LucideIcon;
        sub?: ReactNode;
        /** When set, the whole card is a link and gets a hover-border affordance. */
        href?: string;
        /** Icon-tile background classes (e.g. a brand gradient). Defaults to the muted surface. */
        accentClass?: string;
        badge?: never;
      }
  );

const TILE = 'rounded-2xl border border-[var(--pb-border)] bg-[var(--pb-surface)] px-4 py-4';

/**
 * Shared presentational metric tile. Token-driven (`--pb-*`, dark-mode correct).
 * `centered` — report summary rows; `detailed` — DORA / retention cards; `nav` —
 * icon-leading stat tiles (optionally links). The canonical home is here in `ui/`;
 * `reports/StatCard` re-exports it.
 */
export function StatCard(props: StatCardProps) {
  const { label, value, className = '', wrapperProps } = props;

  if (props.variant === 'nav') {
    const { icon: Icon, sub, href, accentClass } = props;
    const inner = (
      <div
        className={[
          TILE,
          'flex h-full items-center gap-4',
          href ? 'transition-colors hover:border-[var(--pb-brand)]' : '',
          className,
        ].filter(Boolean).join(' ')}
        {...wrapperProps}
      >
        <span
          className={[
            'grid h-11 w-11 shrink-0 place-items-center rounded-xl',
            accentClass ? `text-white ${accentClass}` : 'bg-[var(--pb-surface-muted)] text-[var(--pb-brand)]',
          ].join(' ')}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--pb-text-muted)]">{label}</p>
          {value == null ? (
            <div className="mt-1 h-8 w-16 rounded bg-[var(--pb-surface-muted)]" />
          ) : (
            <p className="text-2xl font-bold tabular-nums text-[var(--pb-text)]">{value}</p>
          )}
          {sub != null && <p className="mt-1 text-xs text-[var(--pb-text-muted)]">{sub}</p>}
        </div>
      </div>
    );
    return href
      ? <Link href={href} className="block rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pb-brand)]">{inner}</Link>
      : inner;
  }

  if (props.variant === 'detailed') {
    const { sub, badge } = props;
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

  return (
    <div className={[TILE, 'text-center', className].filter(Boolean).join(' ')} {...wrapperProps}>
      <p className="text-2xl font-bold tabular-nums text-[var(--pb-text)]">{value}</p>
      <p className="mt-1 text-xs text-[var(--pb-text-muted)]">{label}</p>
    </div>
  );
}
