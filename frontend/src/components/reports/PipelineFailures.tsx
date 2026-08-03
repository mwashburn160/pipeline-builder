import { GitBranch } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { fmtDate, ReportEmpty, SectionHeading, TwoColumnSkeleton, ExportCSVButton } from './ReportHelpers';
import { MAX_LIST_ROWS } from './constants';
import type { StageFailure, ActionFailure, ErrorEntry } from './types';

interface PipelineFailuresProps {
  loading: boolean;
  stageFailures: StageFailure[];
  actionFailures: ActionFailure[];
  errors: ErrorEntry[];
}

/** Pipelines → Failures tab: stage failures, action failures, and top errors. */
export function PipelineFailures({ loading, stageFailures, actionFailures, errors }: PipelineFailuresProps) {
  const hasFailData = stageFailures.length > 0 || actionFailures.length > 0 || errors.length > 0;

  if (loading && !hasFailData) return <TwoColumnSkeleton />;
  if (!loading && !hasFailData) return <EmptyState icon={GitBranch} title="No failure data" description="No stage failures, action failures, or errors recorded for this period." illustration="pipelines" />;

  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-3">
          <SectionHeading>Stage Failures</SectionHeading>
          <ExportCSVButton data={stageFailures.map(s => ({ stage: s.stage_name, failures: s.failures, total: s.total, failure_pct: s.failure_pct }))} filename="stage-failures" />
        </div>
        {stageFailures.length > 0 ? (
          <div className="space-y-2.5">{stageFailures.slice(0, MAX_LIST_ROWS).map((s) => (<div key={s.stage_name}><div className="flex justify-between text-sm mb-1"><span className="text-gray-700 dark:text-gray-300 truncate">{s.stage_name}</span><span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums ml-2 shrink-0">{s.failure_pct}%</span></div><div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"><div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.min(s.failure_pct, 100)}%` }} /></div></div>))}</div>
        ) : <ReportEmpty text="No stage failures" />}
      </Card>
      {actionFailures.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Action Failures</SectionHeading>
            <ExportCSVButton data={actionFailures.map(a => ({ action: a.action_name, failures: a.failures, total: a.total, failure_pct: a.failure_pct }))} filename="action-failures" />
          </div>
          <div className="space-y-2.5">{actionFailures.slice(0, MAX_LIST_ROWS).map((a) => (<div key={a.action_name}><div className="flex justify-between text-sm mb-1"><span className="text-gray-700 dark:text-gray-300 truncate font-mono text-xs">{a.action_name}</span><span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums ml-2 shrink-0">{a.failures}/{a.total} ({a.failure_pct}%)</span></div><div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"><div className="h-full bg-orange-500 rounded-full" style={{ width: `${Math.min(a.failure_pct, 100)}%` }} /></div></div>))}</div>
        </Card>
      )}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <SectionHeading>Top Errors</SectionHeading>
          <ExportCSVButton data={errors.map(e => ({ pattern: e.error_pattern, occurrences: e.occurrences, pipelines: e.affected_pipelines, last_seen: e.last_seen }))} filename="pipeline-errors" />
        </div>
        {errors.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3">{errors.slice(0, MAX_LIST_ROWS).map((e) => (<div key={e.error_pattern} className="border-l-2 border-red-400 pl-3"><p className="text-sm text-gray-900 dark:text-gray-100 line-clamp-1">{e.error_pattern}</p><p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{e.occurrences}x &middot; {e.affected_pipelines} pipeline{e.affected_pipelines !== 1 ? 's' : ''} &middot; {fmtDate(e.last_seen)}</p></div>))}</div>
        ) : <ReportEmpty text="No errors recorded" />}
      </Card>
    </>
  );
}
