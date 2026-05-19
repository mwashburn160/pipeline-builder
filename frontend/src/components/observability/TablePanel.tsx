// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useObservabilityLogs, type RangeKey } from '@/hooks/useObservabilityLogs';
import type { DataSeries, LogEntry } from '@/types/observability';
import { Panel } from './Panel';

interface TablePanelProps {
  queryKey: string;
  title: string;
  range: RangeKey;
  span?: 3 | 4 | 6 | 8 | 9 | 12;
  /** Catalog query mode: 'logs' for stream entries, 'topk' for matrix→ranked list. */
  mode: 'logs' | 'topk';
  /** Optional templated params for the logs mode (event/digest/actor/plugin). */
  logOpts?: { event?: string; digest?: string; actor?: string; plugin?: string; limit?: number };
  /** For topk mode, the label key holding the rank label (default 'actor'). */
  topkLabel?: string;
}

/**
 * Renders either a recent-events list (Loki streams) or a top-N table
 * (Loki matrix aggregated by label). Both visuals share the same shell:
 * a scrollable HTML table, one row per record.
 */
export function TablePanel({ queryKey, title, range, span = 6, mode, logOpts = {}, topkLabel = 'actor' }: TablePanelProps) {
  const { data, loading, error } = useObservabilityLogs(queryKey, range, logOpts);

  const entries: LogEntry[] = mode === 'logs' && data && 'entries' in data ? data.entries : [];
  const series: DataSeries[] = mode === 'topk' && data && 'series' in data ? data.series : [];

  const rowCount = mode === 'logs' ? entries.length : series.length;
  const empty = !loading && !error && rowCount === 0;

  if (empty || loading || error) {
    return <Panel title={title} span={span} loading={loading} error={error} empty={empty}>{null}</Panel>;
  }

  return (
    <Panel title={title} span={span} loading={false} error={null} empty={false}>
      <div className="max-h-72 overflow-auto -mx-2">
        <table className="w-full text-xs">
          {mode === 'logs' ? (
            <>
              <thead className="sticky top-0 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Time</th>
                  <th className="px-2 py-1 text-left font-medium">Event</th>
                  <th className="px-2 py-1 text-left font-medium">Actor</th>
                  <th className="px-2 py-1 text-left font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  // Loki time is in nanoseconds (string). Convert to JS Date via ms.
                  const ms = Math.floor(Number(e.time) / 1_000_000);
                  return (
                    <tr key={i} className="border-t border-gray-100 dark:border-gray-800 align-top">
                      <td className="px-2 py-1 whitespace-nowrap text-gray-500">
                        {new Date(ms).toLocaleTimeString([], { hour12: false })}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap font-mono">{e.labels.event ?? '—'}</td>
                      <td className="px-2 py-1 whitespace-nowrap font-mono">{e.labels.actor ?? '—'}</td>
                      <td className="px-2 py-1 font-mono break-all">{e.line}</td>
                    </tr>
                  );
                })}
              </tbody>
            </>
          ) : (
            <>
              <thead className="sticky top-0 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-2 py-1 text-left font-medium capitalize">{topkLabel}</th>
                  <th className="px-2 py-1 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody>
                {series.map((s, i) => {
                  // For a topk series the values array is the (timestamp, count) tuple
                  // at the latest sample; take the last value as the displayed count.
                  const last = s.values[s.values.length - 1];
                  const count = last ? parseFloat(last.value) : 0;
                  return (
                    <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-2 py-1 font-mono">{s.labels[topkLabel] ?? '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{count.toFixed(0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </>
          )}
        </table>
      </div>
    </Panel>
  );
}
