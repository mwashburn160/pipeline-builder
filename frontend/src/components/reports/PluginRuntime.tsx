// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Puzzle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatDuration } from '@/lib/format';
import { ExportCSVButton, fmtDate, SectionHeading, TwoColumnSkeleton } from './ReportHelpers';
import { MAX_TABLE_ROWS } from './constants';
import type { PluginRuntimeRow } from './types';

/** `acme/terraform-plan` for a published plugin, the bare name for the org's own. */
export function pluginRuntimeLabel(r: Pick<PluginRuntimeRow, 'pluginPublisher' | 'pluginName'>): string {
  return r.pluginPublisher ? `${r.pluginPublisher}/${r.pluginName}` : r.pluginName;
}

function successColor(pct: number): 'green' | 'yellow' | 'red' {
  if (pct >= 95) return 'green';
  if (pct >= 80) return 'yellow';
  return 'red';
}

const COLUMNS: Column<PluginRuntimeRow>[] = [
  { id: 'plugin', header: 'Plugin', cellClassName: 'text-fg truncate max-w-[220px]', render: (r) => pluginRuntimeLabel(r) },
  { id: 'version', header: 'Version', cellClassName: 'tabular-nums text-fg-muted', render: (r) => r.pluginVersion },
  { id: 'runs', header: 'Runs', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => r.runs },
  {
    id: 'success', header: 'Success', headerClassName: 'text-right', cellClassName: 'text-right',
    render: (r) => <Badge color={successColor(r.successPct)}>{`${r.successPct}%`}</Badge>,
  },
  { id: 'p50', header: 'p50', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => (r.p50Ms == null ? '—' : formatDuration(r.p50Ms)) },
  { id: 'p95', header: 'p95', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => (r.p95Ms == null ? '—' : formatDuration(r.p95Ms)) },
  { id: 'last', header: 'Last run', cellClassName: 'text-fg-muted', render: (r) => fmtDate(r.lastRun) },
];

interface PluginRuntimeProps {
  loading: boolean;
  rows: PluginRuntimeRow[];
}

/**
 * Plugins → Runs tab: how each plugin version behaves when this org's pipelines
 * RUN it (terminal step events attributed through the synth step manifest),
 * as opposed to the Builds tab, which is about building the plugin image.
 */
export function PluginRuntime({ loading, rows }: PluginRuntimeProps) {
  if (loading && rows.length === 0) return <TwoColumnSkeleton />;
  if (!loading && rows.length === 0) {
    return (
      <EmptyState
        icon={Puzzle}
        title="No plugin runs yet"
        description="No pipeline in this window ran a plugin step. Runs appear here once a synthesized pipeline executes."
        illustration="plugins"
      />
    );
  }
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <SectionHeading>Plugin runs</SectionHeading>
        <ExportCSVButton
          data={rows.map((r) => ({
            plugin: pluginRuntimeLabel(r), version: r.pluginVersion, runs: r.runs, succeeded: r.succeeded, failed: r.failed,
            success_pct: r.successPct, p50_ms: r.p50Ms ?? '', p95_ms: r.p95Ms ?? '', last_run: r.lastRun,
          }))}
          filename="plugin-runs"
        />
      </div>
      <DataTable
        data={rows.slice(0, MAX_TABLE_ROWS)}
        columns={COLUMNS}
        isLoading={false}
        animated={false}
        getRowKey={(r) => `${r.pluginPublisher ?? ''}/${r.pluginName}@${r.pluginVersion}`}
        emptyState={{ icon: Puzzle, title: 'No data', description: 'No plugin runs yet.' }}
      />
    </Card>
  );
}
