import { GitBranch } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import type { ExecutionCountRow } from '@/types';
import {
  fmtDate, ReportEmpty, SectionHeading,
  StatCardSkeleton, SectionCardSkeleton, StackedTimelineBar,
} from './ReportHelpers';
import { StatCard } from './StatCard';
import type { TimelineEntry } from './types';

interface PipelineOverviewProps {
  loading: boolean;
  executions: ExecutionCountRow[];
  timeline: TimelineEntry[];
}

/** Pipelines → Overview tab: summary stats + execution / success-rate timelines.
 *  (DORA moved to its own top-level, feature-gated tab — see `DoraReport`.) */
export function PipelineOverview({
  loading, executions, timeline,
}: PipelineOverviewProps) {
  const totalExec = executions.reduce((s, p) => s + p.total, 0);
  const totalPass = executions.reduce((s, p) => s + p.succeeded, 0);
  const totalFail = executions.reduce((s, p) => s + p.failed, 0);
  const successRate = totalExec > 0 ? ((totalPass / totalExec) * 100).toFixed(1) : '—';
  const hasOverviewData = executions.length > 0 || timeline.length > 0;

  if (loading && !hasOverviewData) return <><StatCardSkeleton count={4} /><SectionCardSkeleton lines={5} /></>;
  if (!loading && !hasOverviewData) return <EmptyState icon={GitBranch} title="No pipeline data yet" description="No executions in this window — run some pipelines to see execution analytics here." illustration="pipelines" />;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Executions', value: totalExec },
          { label: 'Success Rate', value: successRate === '—' ? '—' : `${successRate}%` },
          { label: 'Failures', value: totalFail },
          { label: 'Pipelines', value: executions.length },
        ].map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} />
        ))}
      </div>
      <Card>
        <SectionHeading>Execution Timeline</SectionHeading>
        {timeline.length > 0 ? (
          <div className="space-y-1.5">
            {timeline.map((entry) => (
              <StackedTimelineBar
                key={entry.period}
                period={entry.period}
                succeeded={entry.succeeded}
                failed={entry.failed}
                canceled={entry.canceled}
              />
            ))}
            <div className="flex items-center gap-2 mt-2"><Badge color="green">Pass</Badge><Badge color="red">Fail</Badge><Badge color="yellow">Canceled</Badge></div>
          </div>
        ) : <ReportEmpty text="No execution data for this period" />}
      </Card>
      {timeline.length > 0 && (
        <Card>
          <SectionHeading>Success Rate Trend</SectionHeading>
          <div className="space-y-1.5">
            {timeline.map((entry) => {
              const pct = Math.round(entry.success_pct);
              const color = pct >= 90 ? 'bg-green-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-red-500';
              return (
                <div key={entry.period} className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 dark:text-gray-500 w-16 shrink-0 tabular-nums">{fmtDate(entry.period)}</span>
                  <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden"><div className={`h-full ${color} rounded`} style={{ width: `${pct}%` }} /></div>
                  <span className={`text-xs tabular-nums w-10 text-right font-medium ${pct >= 90 ? 'text-green-600 dark:text-green-400' : pct >= 70 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>{pct}%</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}
