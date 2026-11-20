import Link from 'next/link';
import { GitBranch } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { fmtDate, ReportEmpty, SectionHeading, TwoColumnSkeleton, ExportCSVButton } from './ReportHelpers';
import { MAX_LIST_ROWS } from './constants';
import type { StageFailure, ActionFailure, ErrorEntry } from './types';
import { pipelineRunsHref } from './report-copy';

/**
 * The pipeline a failure row belongs to, linking to that pipeline's Runs tab
 * (the executions page takes no filter params, so the Runs tab is where a
 * reader finds the failing runs). Rows are grouped per (pipeline, stage), so a
 * stage name alone no longer says where to look.
 */
function PipelineLink({ id, name }: { id: string; name: string | null }) {
  return (
    <Link href={pipelineRunsHref(id)} className="text-xs text-fg-subtle hover:text-brand hover:underline truncate" title="Open this pipeline's runs">
      {name || id}
    </Link>
  );
}

interface PipelineFailuresProps {
  loading: boolean;
  stageFailures: StageFailure[];
  actionFailures: ActionFailure[];
  errors: ErrorEntry[];
  /** Render the cross-org Platform errors card — the operator read is system-org only. */
  showErrors?: boolean;
}

/** Pipelines → Failures tab: stage failures, action failures, and top errors. */
export function PipelineFailures({ loading, stageFailures, actionFailures, errors, showErrors = true }: PipelineFailuresProps) {
  const hasFailData = stageFailures.length > 0 || actionFailures.length > 0 || errors.length > 0;

  if (loading && !hasFailData) return <TwoColumnSkeleton />;
  if (!loading && !hasFailData) return <EmptyState icon={GitBranch} title="No failure data" description="No executions in this window — no stage failures, action failures, or errors recorded for this period." illustration="pipelines" />;

  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-3">
          <SectionHeading>Stage failures</SectionHeading>
          <ExportCSVButton data={stageFailures.map(s => ({ pipeline: s.pipeline_name ?? s.pipeline_id, stage: s.stage_name, failures: s.failures, total: s.total, failure_pct: s.failure_pct }))} filename="stage-failures" />
        </div>
        {stageFailures.length > 0 ? (
          <div className="space-y-2.5">{stageFailures.slice(0, MAX_LIST_ROWS).map((s) => (
            <div key={`${s.pipeline_id}\u0000${s.stage_name}`}>
              <div className="flex justify-between text-sm mb-1 gap-2">
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="text-fg truncate">{s.stage_name}</span>
                  <PipelineLink id={s.pipeline_id} name={s.pipeline_name} />
                </span>
                <span className="text-xs text-fg-subtle tabular-nums ml-2 shrink-0">{s.failures}/{s.total} ({s.failure_pct}%)</span>
              </div>
              <div className="h-1 bg-surface-muted rounded-full overflow-hidden"><div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.min(s.failure_pct, 100)}%` }} /></div>
            </div>
          ))}</div>
        ) : <ReportEmpty text="No stage failures" />}
      </Card>
      {actionFailures.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Action failures</SectionHeading>
            <ExportCSVButton data={actionFailures.map(a => ({ pipeline: a.pipeline_name ?? a.pipeline_id, stage: a.stage_name ?? '', action: a.action_name, failures: a.failures, total: a.total, failure_pct: a.failure_pct }))} filename="action-failures" />
          </div>
          <div className="space-y-2.5">{actionFailures.slice(0, MAX_LIST_ROWS).map((a) => (
            <div key={`${a.pipeline_id}\u0000${a.stage_name ?? ''}\u0000${a.action_name}`}>
              <div className="flex justify-between text-sm mb-1 gap-2">
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="text-fg truncate font-mono text-xs">{a.action_name}</span>
                  <PipelineLink id={a.pipeline_id} name={a.stage_name ? `${a.pipeline_name || a.pipeline_id} / ${a.stage_name}` : a.pipeline_name} />
                </span>
                <span className="text-xs text-fg-subtle tabular-nums ml-2 shrink-0">{a.failures}/{a.total} ({a.failure_pct}%)</span>
              </div>
              <div className="h-1 bg-surface-muted rounded-full overflow-hidden"><div className="h-full bg-orange-500 rounded-full" style={{ width: `${Math.min(a.failure_pct, 100)}%` }} /></div>
            </div>
          ))}</div>
        </Card>
      )}
      {showErrors && (
      <Card>
        <div className="flex items-center justify-between mb-3">
          <SectionHeading>Top errors (all organizations)</SectionHeading>
          <ExportCSVButton data={errors.map(e => ({ pattern: e.error_pattern, occurrences: e.occurrences, pipelines: e.affected_pipelines, last_seen: e.last_seen }))} filename="pipeline-errors" />
        </div>
        {errors.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3">{errors.slice(0, MAX_LIST_ROWS).map((e) => (<div key={e.error_pattern} className="border-l-2 border-danger pl-3"><p className="text-sm text-fg line-clamp-1">{e.error_pattern}</p><p className="text-xs text-fg-subtle mt-0.5">{e.occurrences}x &middot; {e.affected_pipelines} pipeline{e.affected_pipelines !== 1 ? 's' : ''} &middot; {fmtDate(e.last_seen)}</p></div>))}</div>
        ) : <ReportEmpty text="No errors recorded" />}
      </Card>
      )}
    </>
  );
}
