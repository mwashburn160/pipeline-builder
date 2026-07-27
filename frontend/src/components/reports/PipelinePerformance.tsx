import { GitBranch } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ExecutionCountRow } from '@/types';
import { fmtMs, ReportEmpty, SectionHeading, TwoColumnSkeleton, ExportCSVButton } from './ReportHelpers';
import { MAX_TABLE_ROWS, MAX_LIST_ROWS } from './constants';
import type { DurationStat, StageBottleneck } from './types';

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
  if (!loading && !hasPerfData) return <EmptyState icon={GitBranch} title="No performance data yet" description="Run some pipelines to see duration and bottleneck analytics." illustration="pipelines" />;
  if (!hasPerfData) return null;

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Pipeline Executions</SectionHeading>
            <ExportCSVButton data={executions.map(p => ({ pipeline: p.pipeline_name || p.project, total: p.total, passed: p.succeeded, failed: p.failed, canceled: p.canceled }))} filename="pipeline-executions" />
          </div>
          {executions.length > 0 ? (
            <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Pipeline</th><th className="pb-2 font-medium text-right">Total</th><th className="pb-2 font-medium text-right">Pass</th><th className="pb-2 font-medium text-right">Fail</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{executions.slice(0, MAX_TABLE_ROWS).map((p) => (<tr key={p.id}><td className="py-1.5 text-gray-900 dark:text-gray-100 truncate max-w-[200px]">{p.pipeline_name || p.project}</td><td className="py-1.5 text-right tabular-nums">{p.total}</td><td className="py-1.5 text-right tabular-nums text-green-600 dark:text-green-400">{p.succeeded}</td><td className="py-1.5 text-right tabular-nums text-red-600 dark:text-red-400">{p.failed}</td></tr>))}</tbody></table>
          ) : <ReportEmpty text="No execution data yet" />}
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Pipeline Duration</SectionHeading>
            <ExportCSVButton data={durations.map(d => ({ pipeline: d.pipeline_name || d.project, avg_ms: d.avg_ms, min_ms: d.min_ms, max_ms: d.max_ms, p95_ms: d.p95_ms, executions: d.executions }))} filename="pipeline-duration" />
          </div>
          {durations.length > 0 ? (
            <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Pipeline</th><th className="pb-2 font-medium text-right">Avg</th><th className="pb-2 font-medium text-right">P95</th><th className="pb-2 font-medium text-right">Runs</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{durations.slice(0, MAX_TABLE_ROWS).map((d) => (<tr key={d.id}><td className="py-1.5 text-gray-900 dark:text-gray-100 truncate max-w-[200px]">{d.pipeline_name || d.project}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(d.avg_ms)}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(d.p95_ms)}</td><td className="py-1.5 text-right tabular-nums">{d.executions}</td></tr>))}</tbody></table>
          ) : <ReportEmpty text="No duration data yet" />}
        </div>
      </div>
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <SectionHeading>Stage Bottlenecks</SectionHeading>
          <ExportCSVButton data={bottlenecks.map(b => ({ stage: b.stage_name, pipeline: b.pipeline_name || '', avg_ms: b.avg_ms, max_ms: b.max_ms }))} filename="stage-bottlenecks" />
        </div>
        {bottlenecks.length > 0 ? (
          <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Stage</th><th className="pb-2 font-medium text-right">Avg</th><th className="pb-2 font-medium text-right">Max</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{bottlenecks.slice(0, MAX_LIST_ROWS).map((b) => (<tr key={`${b.id}-${b.stage_name}`}><td className="py-1.5"><span className="text-gray-900 dark:text-gray-100 truncate block max-w-[160px]">{b.stage_name}</span>{b.pipeline_name && <span className="text-xs text-gray-400 dark:text-gray-500">{b.pipeline_name}</span>}</td><td className="py-1.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{fmtMs(b.avg_ms)}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(b.max_ms)}</td></tr>))}</tbody></table>
        ) : <ReportEmpty text="No bottleneck data yet" />}
      </div>
    </>
  );
}
