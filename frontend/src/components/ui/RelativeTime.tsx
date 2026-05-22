// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { formatRelativeTime } from '@/lib/relative-time';

interface Props {
  /** Date, ISO string, or epoch ms. */
  value: string | Date | number | null | undefined;
  /**
   * If true, re-renders every 30s so "2m ago" updates to "3m ago" without
   * a page refresh. Default off — most surfaces don't need it.
   */
  live?: boolean;
  /** Fallback rendered when `value` is empty/invalid. */
  fallback?: string;
  className?: string;
}

/**
 * Renders a value as relative time ("2 hours ago") with the full
 * locale-formatted timestamp on hover. The whole point: every list/audit/
 * log surface in the dashboard was rendering raw ISO strings — this
 * component is the single replacement.
 *
 * Cheap to render; opt into `live` only on surfaces where freshness
 * matters (active runs, recent events). Most read-only history rows
 * don't need the interval.
 */
export function RelativeTime({ value, live = false, fallback = '—', className }: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [live]);

  if (value === null || value === undefined || value === '') {
    return <span className={className}>{fallback}</span>;
  }

  const ts = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(ts.getTime())) {
    return <span className={className}>{fallback}</span>;
  }

  return (
    <time dateTime={ts.toISOString()} title={ts.toLocaleString()} className={className}>
      {formatRelativeTime(ts)}
    </time>
  );
}
