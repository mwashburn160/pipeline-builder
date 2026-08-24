// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';

export interface DescriptionItem {
  label: ReactNode;
  value: ReactNode;
}

interface DescriptionListProps {
  items: DescriptionItem[];
  /** `'grid'` (label above value, responsive columns) or `'rows'` (label left,
   *  value right — good for key/value metadata like a token payload). */
  variant?: 'grid' | 'rows';
  className?: string;
}

/**
 * A responsive key/value list (`<dl>`) — replaces the ~9 hand-rolled definition
 * lists scattered across detail views (token inspector, incident metadata, etc.).
 */
export function DescriptionList({ items, variant = 'rows', className = '' }: DescriptionListProps) {
  if (variant === 'grid') {
    return (
      <dl className={['grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3', className].filter(Boolean).join(' ')}>
        {items.map((it, i) => (
          <div key={i} className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-[var(--pb-text-muted)]">{it.label}</dt>
            <dd className="mt-1 break-words text-sm text-[var(--pb-text)]">{it.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={['divide-y divide-[var(--pb-border)]', className].filter(Boolean).join(' ')}>
      {items.map((it, i) => (
        <div key={i} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt className="shrink-0 text-sm text-[var(--pb-text-muted)]">{it.label}</dt>
          <dd className="min-w-0 break-words text-sm text-[var(--pb-text)] sm:text-right">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
