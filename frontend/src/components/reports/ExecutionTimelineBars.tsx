// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stacked-bar visualisation of execution outcomes (succeeded / failed /
 * canceled) over time, with a per-bucket success-percent label.
 *
 * Extracted from `pages/dashboard/reports.tsx` and `pages/dashboard/index.tsx`
 * (N33) so the timeline can be reused without re-implementing the bar maths
 * and color scale in every consumer.
 *
 * TODO(pages-agent): consume this component in
 *   - pages/dashboard/reports.tsx:233-275
 *   - pages/dashboard/index.tsx:414-end
 * (Both currently render the inline equivalent.)
 *
 * NOTE: the backend's `getExecutionTimeline` endpoint was removed; callers
 * should feed `entries` from `api.getSuccessRate()` — the response shape is
 * identical.
 */

import { ReportEmpty } from './ReportHelpers';

export interface ExecutionTimelineEntry {
  period: string;
  succeeded: number;
  failed: number;
  canceled: number;
  /** Success percentage 0-100 for the bucket; pre-computed server-side. */
  success_pct: number;
}

interface Props {
  entries: ReadonlyArray<ExecutionTimelineEntry>;
}

export function ExecutionTimelineBars({ entries }: Props) {
  if (entries.length === 0) {
    return <ReportEmpty text="No executions in the selected range." />;
  }

  // Scale every bar against the largest bucket so visual proportions are
  // meaningful even when totals vary by an order of magnitude.
  const maxTotal = entries.reduce((m, e) => Math.max(m, e.succeeded + e.failed + e.canceled), 0) || 1;

  return (
    <div className="space-y-1.5">
      {entries.map((e) => {
        const total = e.succeeded + e.failed + e.canceled;
        const widthPct = (total / maxTotal) * 100;
        const okPct = total > 0 ? (e.succeeded / total) * 100 : 0;
        const failPct = total > 0 ? (e.failed / total) * 100 : 0;
        const cancelPct = total > 0 ? (e.canceled / total) * 100 : 0;
        return (
          <div key={e.period} className="flex items-center gap-2 text-xs">
            <div className="w-24 shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
              {e.period}
            </div>
            <div className="flex-1 h-4 rounded bg-gray-100 dark:bg-gray-800 overflow-hidden">
              <div className="h-full flex" style={{ width: `${widthPct}%` }}>
                <div className="bg-green-500" style={{ width: `${okPct}%` }} title={`${e.succeeded} succeeded`} />
                <div className="bg-red-500" style={{ width: `${failPct}%` }} title={`${e.failed} failed`} />
                <div className="bg-gray-400" style={{ width: `${cancelPct}%` }} title={`${e.canceled} canceled`} />
              </div>
            </div>
            <div className="w-12 shrink-0 text-right tabular-nums text-gray-600 dark:text-gray-300">
              {e.success_pct}%
            </div>
            <div className="w-12 shrink-0 text-right tabular-nums text-gray-400 dark:text-gray-500">
              {total}
            </div>
          </div>
        );
      })}
    </div>
  );
}
