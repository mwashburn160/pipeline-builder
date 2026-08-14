// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { List } from 'lucide-react';
import { useObservabilityLogs } from '@/hooks/useObservabilityLogs';
import { DataTable, type Column } from '@/components/ui/DataTable';
import type { RangeKey } from '@/types/observability';
import type { DataSeries, ObservabilityLogEntry } from '@/types/observability';
import { Panel } from './Panel';

const LOGS_COLUMNS: Column<ObservabilityLogEntry>[] = [
  {
    id: 'time',
    header: 'Time',
    cellClassName: 'whitespace-nowrap text-gray-500',
    render: (e) => {
      // Loki time is in nanoseconds (string). Convert to JS Date via ms.
      const ms = Math.floor(Number(e.time) / 1_000_000);
      return <span title={new Date(ms).toLocaleString([], { hour12: false })}>{new Date(ms).toLocaleTimeString([], { hour12: false })}</span>;
    },
  },
  { id: 'event', header: 'Event', cellClassName: 'whitespace-nowrap font-mono', render: (e) => e.labels.event ?? '—' },
  { id: 'actor', header: 'Actor', cellClassName: 'whitespace-nowrap font-mono', render: (e) => e.labels.actor ?? '—' },
  { id: 'message', header: 'Message', cellClassName: 'font-mono break-all', render: (e) => e.line },
];

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

  const entries: ObservabilityLogEntry[] = mode === 'logs' && data && 'entries' in data ? data.entries : [];
  const series: DataSeries[] = mode === 'topk' && data && 'series' in data ? data.series : [];

  const rowCount = mode === 'logs' ? entries.length : series.length;
  const empty = !loading && !error && rowCount === 0;

  if (empty || loading || error) {
    return <Panel title={title} span={span} loading={loading} error={error} empty={empty}>{null}</Panel>;
  }

  const topkColumns: Column<DataSeries>[] = [
    { id: 'label', header: <span className="capitalize">{topkLabel}</span>, cellClassName: 'font-mono', render: (s) => s.labels[topkLabel] ?? '—' },
    {
      id: 'count',
      header: 'Count',
      headerClassName: 'text-right',
      cellClassName: 'text-right tabular-nums',
      render: (s) => {
        // For a topk series the values array is the (timestamp, count) tuple at
        // the latest sample; take the last value as the displayed count.
        const last = s.values[s.values.length - 1];
        return (last ? parseFloat(last.value) : 0).toFixed(0);
      },
    },
  ];

  return (
    <Panel title={title} span={span} loading={false} error={null} empty={false}>
      <div className="max-h-72 overflow-auto -mx-2 text-xs">
        {mode === 'logs' ? (
          <DataTable
            data={entries}
            columns={LOGS_COLUMNS}
            isLoading={false}
            animated={false}
            getRowKey={(e) => `${e.time}-${e.line}`}
            emptyState={{ icon: List, title: 'No events', description: 'No recent events in range.' }}
          />
        ) : (
          <DataTable
            data={series}
            columns={topkColumns}
            isLoading={false}
            animated={false}
            getRowKey={(s, i) => s.labels[topkLabel] ?? `row-${i}`}
            emptyState={{ icon: List, title: 'No data', description: 'No ranked results in range.' }}
          />
        )}
      </div>
    </Panel>
  );
}
