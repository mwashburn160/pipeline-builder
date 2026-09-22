// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatError } from '@/lib/constants';

interface PanelProps {
  title: string;
  /** Tailwind col-span value (1-12). Default 12 (full-width). */
  span?: 3 | 4 | 6 | 8 | 9 | 12;
  loading: boolean;
  error: Error | null;
  /** True when the query succeeded but returned no data. Distinct from `error`. */
  empty: boolean;
  children: ReactNode;
}

const SPAN_CLASS: Record<NonNullable<PanelProps['span']>, string> = {
  3: 'col-span-12 md:col-span-3',
  4: 'col-span-12 md:col-span-4',
  6: 'col-span-12 md:col-span-6',
  8: 'col-span-12 md:col-span-8',
  9: 'col-span-12 md:col-span-9',
  12: 'col-span-12',
};

/**
 * Container for one observability panel. Handles three rendering states
 * that every panel shares  loading skeleton, error banner, "no data"
 * placeholder  so the inner viz components only deal with the happy path.
 */
export function Panel({ title, span = 6, loading, error, empty, children }: PanelProps) {
  return (
    // `h-full` lets the panel fill a parent with explicit height — needed in
    // grid mode where react-grid-layout positions panels with fixed pixel
    // heights. In span-grid mode `h-full` is a no-op (the parent doesn't
    // constrain height) so existing layouts render unchanged.
    <div className={`${SPAN_CLASS[span]} h-full rounded-lg border border-default bg-surface p-4 flex flex-col`}>
      <h3 className="text-sm font-semibold text-fg-muted mb-3">{title}</h3>
      <div className="flex-1 min-h-[8rem] flex items-center justify-center">
        {error ? (
          <div className="text-xs text-danger text-center px-2">
            <div className="font-medium mb-1">Failed to load</div>
            <div className="text-fg-muted break-words">{formatError(error, 'Something went wrong')}</div>
          </div>
        ) : loading ? (
          <div className="w-full space-y-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ) : empty ? (
          <div className="text-xs text-fg-subtle">No data in this range</div>
        ) : (
          <div className="w-full">{children}</div>
        )}
      </div>
    </div>
  );
}
