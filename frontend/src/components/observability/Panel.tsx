// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';

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
 * that every panel shares — loading skeleton, error banner, "no data"
 * placeholder — so the inner viz components only deal with the happy path.
 */
export function Panel({ title, span = 6, loading, error, empty, children }: PanelProps) {
  return (
    <div className={`${SPAN_CLASS[span]} rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 flex flex-col`}>
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{title}</h3>
      <div className="flex-1 min-h-[8rem] flex items-center justify-center">
        {error ? (
          <div className="text-xs text-red-600 dark:text-red-400 text-center px-2">
            <div className="font-medium mb-1">Failed to load</div>
            <div className="text-gray-500 dark:text-gray-400 break-words">{error.message}</div>
          </div>
        ) : loading ? (
          <div className="w-full space-y-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ) : empty ? (
          <div className="text-xs text-gray-400 dark:text-gray-500">No data in this range</div>
        ) : (
          <div className="w-full">{children}</div>
        )}
      </div>
    </div>
  );
}
