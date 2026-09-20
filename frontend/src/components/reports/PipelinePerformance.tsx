import { GitBranch } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import type { ExecutionCountRow } from '@/types';
import { ReportEmpty, SectionHeading, TwoColumnSkeleton, ExportCSVButton } from './ReportHelpers';
import { MAX_TABLE_ROWS, MAX_LIST_ROWS } from './constants';
import type { DurationStat, StageBottleneck } from './types';
import { formatDuration } from '@/lib/format';

const EXECUTION_COLUMNS: Column<ExecutionCountRow>[] = [
  { id: 'pipeline', header: 'Pipeline', cellClassName: 'text-fg truncate max-w-[200px]', render: (p) => p.pipeline_name || p.project },
  { id: 'total', header: 'Total', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (p) => p.total },
  { id: 'pass', header: 'Pass', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums text-success', render: (p) => p.succeeded },
  { id: 'fail', header: 'Fail', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums text-danger', render: (p) => p.failed },
];

const DURATION_COLUMNS: Column<DurationStat>[] = [
  { id: 'pipeline', header: 'Pipeline', cellClassName: 'text-fg truncate max-w-[200px]', render: (d) => d.pipeline_name || d.project },
  { id: 'avg', header: 'Avg', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (d) => formatDuration(d.avg_ms) },
  { id: 'p95', header: 'P95', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (d) => formatDuration(d.p95_ms) },
  { id: 'runs', header: 'Runs', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (d) => d.executions },
];

const BOTTLENECK_COLUMNS: Column<StageBottleneck>[] = [
  {
    id: 'stage',
    header: 'Stage',
    render: (b) => (
      <>
        <span className="text-fg truncate block max-w-[160px]">{b.stage_name}</span>
        {b.pipeline_name && <span className="text-xs text-fg-subtle">{b.pipeline_name}</span>}
      </>
    ),
  },
  { id: 'avg', header: 'Avg', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums text-warning', render: (b) => formatDuration(b.avg_ms) },
  { id: 'max', header: 'Max', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (b) => formatDuration(b.max_ms) },
];

interface PipelinePerformanceProps {
  loading: boolean;
  executions: ExecutionCountRow[];
  durations: DurationStat[];
  bottlenecks: StageBottleneck[];
}

/** Pipelines → Performance tab: execution counts, durations, and stage bottlenecks. */
export function PipelinePerformance({ loading, executions, durations, bottlenecks }: PipelinePerformanceProps) {
  const hasPerfData = executions.length > 0 || durations.length > 0;

  if (loading && !hasPerfData) return <TwoColumnSkeleton />;
  if (!loading && !hasPerfData) return <EmptyState icon={GitBranch} title="No performance data yet" description="No executions in this window — run some pipelines to see duration and bottleneck analytics." illustration="pipelines" />;

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Pipeline Executions</SectionHeading>
            <ExportCSVButton data={executions.map(p => ({ pipeline: p.pipeline_name || p.project, total: p.total, passed: p.succeeded, failed: p.failed, canceled: p.canceled }))} filename="pipeline-executions" />
          </div>
          {executions.length > 0 ? (
            <DataTable data={executions.slice(0, MAX_TABLE_ROWS)} columns={EXECUTION_COLUMNS} isLoading={false} animated={false} getRowKey={(p) => p.id} emptyState={{ icon: GitBranch, title: 'No data', description: 'No execution data yet.' }} />
          ) : <ReportEmpty text="No execution data yet" />}
        </Card>
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Pipeline Duration</SectionHeading>
            <ExportCSVButton data={durations.map(d => ({ pipeline: d.pipeline_name || d.project, avg_ms: d.avg_ms, min_ms: d.min_ms, max_ms: d.max_ms, p95_ms: d.p95_ms, executions: d.executions }))} filename="pipeline-duration" />
          </div>
          {durations.length > 0 ? (
            <DataTable data={durations.slice(0, MAX_TABLE_ROWS)} columns={DURATION_COLUMNS} isLoading={false} animated={false} getRowKey={(d) => d.id} emptyState={{ icon: GitBranch, title: 'No data', description: 'No duration data yet.' }} />
          ) : <ReportEmpty text="No duration data yet" />}
        </Card>
      </div>
      <Card>
        <div className="flex items-center justify-between mb-3">
          <SectionHeading>Stage Bottlenecks</SectionHeading>
          <ExportCSVButton data={bottlenecks.map(b => ({ stage: b.stage_name, pipeline: b.pipeline_name || '', avg_ms: b.avg_ms, max_ms: b.max_ms }))} filename="stage-bottlenecks" />
        </div>
        {bottlenecks.length > 0 ? (
          <DataTable data={bottlenecks.slice(0, MAX_LIST_ROWS)} columns={BOTTLENECK_COLUMNS} isLoading={false} animated={false} getRowKey={(b) => `${b.id}-${b.stage_name}`} emptyState={{ icon: GitBranch, title: 'No data', description: 'No bottleneck data yet.' }} />
        ) : <ReportEmpty text="No bottleneck data yet" />}
      </Card>
    </>
  );
}
