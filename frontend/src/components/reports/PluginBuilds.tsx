import { Puzzle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { fmtMs, fmtDate, ReportEmpty, SectionHeading, StackedTimelineBar, TwoColumnSkeleton, ExportCSVButton } from './ReportHelpers';
import { MAX_TABLE_ROWS, MAX_BUILD_FAILURE_ROWS } from './constants';
import type { BuildSuccessEntry, BuildDurationStat, BuildFailure } from './types';

const BUILD_DURATION_COLUMNS: Column<BuildDurationStat>[] = [
  { id: 'plugin', header: 'Plugin', cellClassName: 'text-gray-900 dark:text-gray-100 truncate max-w-[200px]', render: (d) => d.plugin_name },
  { id: 'avg', header: 'Avg', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (d) => fmtMs(d.avg_ms) },
  { id: 'max', header: 'Max', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (d) => fmtMs(d.max_ms) },
  { id: 'builds', header: 'Builds', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (d) => d.builds },
];

interface PluginBuildsProps {
  loading: boolean;
  buildTimeline: BuildSuccessEntry[];
  buildDurations: BuildDurationStat[];
  buildFailures: BuildFailure[];
}

/** Plugins → Builds tab: build success-rate timeline, durations, and recent failures. */
export function PluginBuilds({ loading, buildTimeline, buildDurations, buildFailures }: PluginBuildsProps) {
  const hasBuildsData = buildTimeline.length > 0 || buildDurations.length > 0 || buildFailures.length > 0;

  if (loading && !hasBuildsData) return <TwoColumnSkeleton />;
  if (!loading && !hasBuildsData) return <EmptyState icon={Puzzle} title="No build data yet" description="No builds in this window — build some plugins to see success rates, durations, and failures." illustration="plugins" />;

  return (
    <>
      {buildTimeline.length > 0 && (
        <Card>
          <SectionHeading>Build Success Rate</SectionHeading>
          <div className="space-y-1.5">
            {buildTimeline.map((entry) => (
              <StackedTimelineBar key={entry.period} period={entry.period} succeeded={entry.succeeded} failed={entry.failed} />
            ))}
            <div className="flex items-center gap-2 mt-2"><Badge color="green">Pass</Badge><Badge color="red">Fail</Badge></div>
          </div>
        </Card>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Build Duration</SectionHeading>
            <ExportCSVButton data={buildDurations.map(d => ({ plugin: d.plugin_name, avg_ms: d.avg_ms, max_ms: d.max_ms, builds: d.builds }))} filename="build-duration" />
          </div>
          {buildDurations.length > 0 ? (
            <DataTable
              data={buildDurations.slice(0, MAX_TABLE_ROWS)}
              columns={BUILD_DURATION_COLUMNS}
              isLoading={false}
              animated={false}
              getRowKey={(d) => d.plugin_name}
              emptyState={{ icon: Puzzle, title: 'No data', description: 'No build duration data yet.' }}
            />
          ) : <ReportEmpty text="No build duration data yet" />}
        </Card>
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Recent Build Failures</SectionHeading>
            <ExportCSVButton data={buildFailures.map(f => ({ plugin: f.plugin_name, error_message: f.error_message, occurrences: f.occurrences, last_seen: f.last_seen }))} filename="build-failures" />
          </div>
          {buildFailures.length > 0 ? (
            <div className="space-y-3">{buildFailures.slice(0, MAX_BUILD_FAILURE_ROWS).map((f) => (<div key={`${f.plugin_name}-${f.last_seen}`} className="border-l-2 border-red-400 pl-3"><p className="text-sm text-gray-900 dark:text-gray-100">{f.plugin_name}</p><p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mt-0.5">{f.error_message}</p><p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{f.occurrences}x &middot; {fmtDate(f.last_seen)}</p></div>))}</div>
          ) : <ReportEmpty text="No build failures" />}
        </Card>
      </div>
    </>
  );
}
