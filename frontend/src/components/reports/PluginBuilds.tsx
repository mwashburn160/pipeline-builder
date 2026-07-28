import { Puzzle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { fmtMs, fmtDate, ReportEmpty, SectionHeading, StackedTimelineBar, TwoColumnSkeleton, ExportCSVButton } from './ReportHelpers';
import { MAX_TABLE_ROWS, MAX_BUILD_FAILURE_ROWS } from './constants';
import type { BuildSuccessEntry, BuildDurationStat, BuildFailure } from './types';

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
  if (!loading && !hasBuildsData) return <EmptyState icon={Puzzle} title="No build data yet" description="Build some plugins to see success rates, durations, and failures." illustration="plugins" />;

  return (
    <>
      {buildTimeline.length > 0 && (
        <div className="card">
          <SectionHeading>Build Success Rate</SectionHeading>
          <div className="space-y-1.5">
            {buildTimeline.map((entry) => (
              <StackedTimelineBar key={entry.period} period={entry.period} succeeded={entry.succeeded} failed={entry.failed} />
            ))}
            <div className="flex items-center gap-2 mt-2"><Badge color="green">Pass</Badge><Badge color="red">Fail</Badge></div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Build Duration</SectionHeading>
            <ExportCSVButton data={buildDurations.map(d => ({ plugin: d.plugin_name, avg_ms: d.avg_ms, max_ms: d.max_ms, builds: d.builds }))} filename="build-duration" />
          </div>
          {buildDurations.length > 0 ? (
            <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Plugin</th><th className="pb-2 font-medium text-right">Avg</th><th className="pb-2 font-medium text-right">Max</th><th className="pb-2 font-medium text-right">Builds</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{buildDurations.slice(0, MAX_TABLE_ROWS).map((d) => (<tr key={d.plugin_name}><td className="py-1.5 text-gray-900 dark:text-gray-100 truncate max-w-[200px]">{d.plugin_name}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(d.avg_ms)}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(d.max_ms)}</td><td className="py-1.5 text-right tabular-nums">{d.builds}</td></tr>))}</tbody></table>
          ) : <ReportEmpty text="No build duration data yet" />}
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <SectionHeading>Recent Build Failures</SectionHeading>
            <ExportCSVButton data={buildFailures.map(f => ({ plugin: f.plugin_name, error_message: f.error_message, occurrences: f.occurrences, last_seen: f.last_seen }))} filename="build-failures" />
          </div>
          {buildFailures.length > 0 ? (
            <div className="space-y-3">{buildFailures.slice(0, MAX_BUILD_FAILURE_ROWS).map((f) => (<div key={`${f.plugin_name}-${f.last_seen}`} className="border-l-2 border-red-400 pl-3"><p className="text-sm text-gray-900 dark:text-gray-100">{f.plugin_name}</p><p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mt-0.5">{f.error_message}</p><p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{f.occurrences}x &middot; {fmtDate(f.last_seen)}</p></div>))}</div>
          ) : <ReportEmpty text="No build failures" />}
        </div>
      </div>
    </>
  );
}
