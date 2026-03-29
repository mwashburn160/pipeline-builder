import dynamic from 'next/dynamic';
import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { GitBranch, Puzzle, AlertTriangle, FileBarChart } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';

const ReportTabs = dynamic(() => import('@/components/reports/ReportTabs'), {
  loading: () => <LoadingPage />,
});
import {
  fmtMs, fmtDate, ReportEmpty, SectionHeading,
  StatCardSkeleton, SectionCardSkeleton, TwoColumnSkeleton,
  DateRangePicker, AutoRefresh, ExportCSVButton,
} from '@/components/reports/ReportHelpers';
import api from '@/lib/api';

// ─── Pipeline Types ─────────────────────────────────────
interface ExecutionCount { id: string; project: string; organization: string; pipeline_name: string | null; total: number; succeeded: number; failed: number; canceled: number; first_execution: string | null; last_execution: string | null }
interface TimelineEntry { period: string; succeeded: number; failed: number; canceled: number; success_pct: number }
interface DurationStat { id: string; project: string; pipeline_name: string | null; avg_ms: number; min_ms: number; max_ms: number; p95_ms: number; executions: number }
interface StageFailure { stage_name: string; failures: number; total: number; failure_pct: number }
interface StageBottleneck { id: string; pipeline_name: string | null; stage_name: string; avg_ms: number; max_ms: number }
interface ErrorEntry { error_pattern: string; occurrences: number; affected_pipelines: number; last_seen: string }
interface SuccessRateEntry { period: string; succeeded: number; failed: number; canceled: number; success_pct: number }
interface ActionFailure { action_name: string; failures: number; total: number; failure_pct: number }

// ─── Plugin Types ───────────────────────────────────────
interface PluginSummary { total: number; active: number; inactive: number; public: number; private: number; unique_names: number }
interface PluginVersion { name: string; version_count: number; latest_version: string; has_default: boolean }
interface BuildSuccessEntry { period: string; succeeded: number; failed: number; success_pct: number }
interface BuildDurationStat { plugin_name: string; avg_ms: number; max_ms: number; builds: number }
interface BuildFailure { plugin_name: string; error_message: string; occurrences: number; last_seen: string }
interface PluginDistribution { plugin_type: string; compute_type: string; count: number }

// ─── Tab Config ─────────────────────────────────────────
type TopTab = 'pipelines' | 'plugins';
type PipelineSubTab = 'overview' | 'performance' | 'failures';
type PluginSubTab = 'overview' | 'builds' | 'versions';

const TOP_TABS: { id: TopTab; label: string; icon: typeof GitBranch }[] = [
  { id: 'pipelines', label: 'Pipelines', icon: GitBranch },
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
];

const PIPELINE_TABS: { id: PipelineSubTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'performance', label: 'Performance' },
  { id: 'failures', label: 'Failures' },
];

const PLUGIN_TABS: { id: PluginSubTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'builds', label: 'Builds' },
  { id: 'versions', label: 'Versions' },
];

// ─── Page ───────────────────────────────────────────────
export default function ReportsPage() {
  const { user, isReady, isAuthenticated } = useAuthGuard();

  const [topTab, setTopTab] = useState<TopTab>('pipelines');
  const [pipelineTab, setPipelineTab] = useState<PipelineSubTab>('overview');
  const [pluginTab, setPluginTab] = useState<PluginSubTab>('overview');
  const [timeInterval, setTimeInterval] = useState<'day' | 'week' | 'month'>('week');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);

  // Pipeline data
  const [executions, setExecutions] = useState<ExecutionCount[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [successRateTrend, setSuccessRateTrend] = useState<SuccessRateEntry[]>([]);
  const [durations, setDurations] = useState<DurationStat[]>([]);
  const [bottlenecks, setBottlenecks] = useState<StageBottleneck[]>([]);
  const [stageFailures, setStageFailures] = useState<StageFailure[]>([]);
  const [actionFailures, setActionFailures] = useState<ActionFailure[]>([]);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);

  // Plugin data
  const [pluginSummary, setPluginSummary] = useState<PluginSummary | null>(null);
  const [distribution, setDistribution] = useState<PluginDistribution[]>([]);
  const [buildTimeline, setBuildTimeline] = useState<BuildSuccessEntry[]>([]);
  const [buildDurations, setBuildDurations] = useState<BuildDurationStat[]>([]);
  const [buildFailures, setBuildFailures] = useState<BuildFailure[]>([]);
  const [pluginVersions, setPluginVersions] = useState<PluginVersion[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const dateParams: Record<string, string> = {};
    if (dateFrom) dateParams.from = dateFrom;
    if (dateTo) dateParams.to = dateTo;

    try {
      if (topTab === 'pipelines') {
        if (pipelineTab === 'overview') {
          const [execRes, timelineRes, successRateRes] = await Promise.allSettled([
            api.getExecutionCount(), api.getExecutionTimeline({ interval: timeInterval, ...dateParams }), api.getSuccessRate({ interval: timeInterval, ...dateParams }),
          ]);
          if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
          if (timelineRes.status === 'fulfilled') setTimeline(timelineRes.value.data?.timeline || []);
          if (successRateRes.status === 'fulfilled') setSuccessRateTrend(successRateRes.value.data?.timeline || []);
        } else if (pipelineTab === 'performance') {
          const [execRes, durationRes, bottleneckRes] = await Promise.allSettled([
            api.getExecutionCount(), api.getPipelineDuration(dateParams), api.getStageBottlenecks(dateParams),
          ]);
          if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
          if (durationRes.status === 'fulfilled') setDurations(durationRes.value.data?.pipelines || []);
          if (bottleneckRes.status === 'fulfilled') setBottlenecks(bottleneckRes.value.data?.stages || []);
        } else {
          const [stageRes, actionRes, errorRes] = await Promise.allSettled([
            api.getStageFailures(dateParams), api.getActionFailures(dateParams), api.getExecutionErrors({ limit: 10, ...dateParams }),
          ]);
          if (stageRes.status === 'fulfilled') setStageFailures(stageRes.value.data?.stages || []);
          if (actionRes.status === 'fulfilled') setActionFailures(actionRes.value.data?.actions || []);
          if (errorRes.status === 'fulfilled') setErrors(errorRes.value.data?.errors || []);
        }
      } else {
        if (pluginTab === 'overview') {
          const [sumRes, distRes] = await Promise.allSettled([api.getPluginSummary(), api.getPluginDistribution()]);
          if (sumRes.status === 'fulfilled') setPluginSummary(sumRes.value.data?.summary || null);
          if (distRes.status === 'fulfilled') setDistribution(distRes.value.data?.distribution || []);
        } else if (pluginTab === 'builds') {
          const [timelineRes, durRes, failRes] = await Promise.allSettled([
            api.getBuildSuccessRate({ interval: timeInterval, ...dateParams }), api.getBuildDuration(dateParams), api.getBuildFailures({ limit: 10, ...dateParams }),
          ]);
          if (timelineRes.status === 'fulfilled') setBuildTimeline(timelineRes.value.data?.timeline || []);
          if (durRes.status === 'fulfilled') setBuildDurations(durRes.value.data?.plugins || []);
          if (failRes.status === 'fulfilled') setBuildFailures(failRes.value.data?.failures || []);
        } else {
          const [verRes] = await Promise.allSettled([api.getPluginVersions()]);
          if (verRes.status === 'fulfilled') setPluginVersions(verRes.value.data?.plugins || []);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [topTab, pipelineTab, pluginTab, timeInterval, dateFrom, dateTo]);

  useEffect(() => {
    if (isAuthenticated) fetchData();
  }, [isAuthenticated, fetchData]);

  if (!isReady || !user) return <LoadingPage />;

  // Pipeline computed
  const totalExec = executions.reduce((s, p) => s + p.total, 0);
  const totalPass = executions.reduce((s, p) => s + p.succeeded, 0);
  const totalFail = executions.reduce((s, p) => s + p.failed, 0);
  const successRate = totalExec > 0 ? ((totalPass / totalExec) * 100).toFixed(1) : '—';
  const hasOverviewData = executions.length > 0 || timeline.length > 0;
  const hasPerfData = executions.length > 0 || durations.length > 0;
  const hasFailData = stageFailures.length > 0 || actionFailures.length > 0 || errors.length > 0;

  // Plugin computed
  const hasPluginOverview = pluginSummary !== null;
  const hasBuildsData = buildTimeline.length > 0 || buildDurations.length > 0 || buildFailures.length > 0;
  const hasVersionsData = pluginVersions.length > 0;
  const typeDistribution = distribution.reduce<Record<string, number>>((acc, d) => { acc[d.plugin_type] = (acc[d.plugin_type] || 0) + d.count; return acc; }, {});
  const computeDistribution = distribution.reduce<Record<string, number>>((acc, d) => { acc[d.compute_type] = (acc[d.compute_type] || 0) + d.count; return acc; }, {});
  const maxDistCount = Math.max(1, ...Object.values(typeDistribution), ...Object.values(computeDistribution));
  const stalePlugins = pluginVersions.filter(v => !v.has_default);

  return (
    <DashboardLayout
      title="Reports"
      subtitle="Pipeline execution analytics and plugin build insights"
      maxWidth="7xl"
      actions={
        <div className="flex items-center gap-3">
          <DateRangePicker from={dateFrom} to={dateTo} onFromChange={setDateFrom} onToChange={setDateTo} />
          <select value={timeInterval} onChange={(e) => setTimeInterval(e.target.value as 'day' | 'week' | 'month')} className="filter-select">
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
          <AutoRefresh onRefresh={fetchData} loading={loading} />
        </div>
      }
    >
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="page-section space-y-6">

        {/* ═══════ Top-level tabs: Pipelines / Plugins ═══════ */}
        <div className="flex gap-2">
          {TOP_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = topTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setTopTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 ring-1 ring-blue-200 dark:ring-blue-800'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* ═══════════════════ PIPELINES ═══════════════════ */}
        {topTab === 'pipelines' && (
          <>
            <ReportTabs tabs={PIPELINE_TABS} activeTab={pipelineTab} onTabChange={(id) => setPipelineTab(id as PipelineSubTab)} />

            {/* Overview */}
            {pipelineTab === 'overview' && (
              <>
                {loading && !hasOverviewData && <><StatCardSkeleton count={4} /><SectionCardSkeleton lines={5} /></>}
                {!loading && !hasOverviewData && <EmptyState icon={GitBranch} title="No pipeline data yet" description="Run some pipelines to see execution analytics here." illustration="pipelines" />}
                {hasOverviewData && (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      {[
                        { label: 'Executions', value: totalExec },
                        { label: 'Success Rate', value: successRate === '—' ? '—' : `${successRate}%` },
                        { label: 'Failures', value: totalFail },
                        { label: 'Pipelines', value: executions.length },
                      ].map((s) => (
                        <div key={s.label} className="card py-4 text-center">
                          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.value}</p>
                          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{s.label}</p>
                        </div>
                      ))}
                    </div>
                    <div className="card">
                      <SectionHeading>Execution Timeline</SectionHeading>
                      {timeline.length > 0 ? (
                        <div className="space-y-1.5">
                          {timeline.map((entry) => {
                            const total = entry.succeeded + entry.failed + entry.canceled;
                            const sPct = total > 0 ? (entry.succeeded / total) * 100 : 0;
                            const fPct = total > 0 ? (entry.failed / total) * 100 : 0;
                            const cPct = total > 0 ? (entry.canceled / total) * 100 : 0;
                            return (
                              <div key={entry.period} className="flex items-center gap-3">
                                <span className="text-xs text-gray-400 dark:text-gray-500 w-16 shrink-0 tabular-nums">{fmtDate(entry.period)}</span>
                                <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden flex">
                                  {sPct > 0 && <div className="h-full bg-green-500" style={{ width: `${sPct}%` }} />}
                                  {fPct > 0 && <div className="h-full bg-red-500" style={{ width: `${fPct}%` }} />}
                                  {cPct > 0 && <div className="h-full bg-yellow-400" style={{ width: `${cPct}%` }} />}
                                </div>
                                <span className="text-xs text-gray-400 dark:text-gray-500 w-12 text-right tabular-nums">{total}</span>
                              </div>
                            );
                          })}
                          <div className="flex items-center gap-2 mt-2"><Badge color="green">Pass</Badge><Badge color="red">Fail</Badge><Badge color="yellow">Canceled</Badge></div>
                        </div>
                      ) : <ReportEmpty text="No execution data for this period" />}
                    </div>
                    {successRateTrend.length > 0 && (
                      <div className="card">
                        <SectionHeading>Success Rate Trend</SectionHeading>
                        <div className="space-y-1.5">
                          {successRateTrend.map((entry) => {
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
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {/* Performance */}
            {pipelineTab === 'performance' && (
              <>
                {loading && !hasPerfData && <TwoColumnSkeleton />}
                {!loading && !hasPerfData && <EmptyState icon={GitBranch} title="No performance data yet" description="Run some pipelines to see duration and bottleneck analytics." illustration="pipelines" />}
                {hasPerfData && (
                  <>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <div className="card">
                        <div className="flex items-center justify-between mb-3">
                          <SectionHeading>Pipeline Executions</SectionHeading>
                          <ExportCSVButton data={executions.map(p => ({ pipeline: p.pipeline_name || p.project, total: p.total, passed: p.succeeded, failed: p.failed, canceled: p.canceled }))} filename="pipeline-executions" />
                        </div>
                        {executions.length > 0 ? (
                          <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Pipeline</th><th className="pb-2 font-medium text-right">Total</th><th className="pb-2 font-medium text-right">Pass</th><th className="pb-2 font-medium text-right">Fail</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{executions.slice(0, 10).map((p) => (<tr key={p.id}><td className="py-1.5 text-gray-900 dark:text-gray-100 truncate max-w-[200px]">{p.pipeline_name || p.project}</td><td className="py-1.5 text-right tabular-nums">{p.total}</td><td className="py-1.5 text-right tabular-nums text-green-600 dark:text-green-400">{p.succeeded}</td><td className="py-1.5 text-right tabular-nums text-red-600 dark:text-red-400">{p.failed}</td></tr>))}</tbody></table>
                        ) : <ReportEmpty text="No execution data yet" />}
                      </div>
                      <div className="card">
                        <SectionHeading>Pipeline Duration</SectionHeading>
                        {durations.length > 0 ? (
                          <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Pipeline</th><th className="pb-2 font-medium text-right">Avg</th><th className="pb-2 font-medium text-right">P95</th><th className="pb-2 font-medium text-right">Runs</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{durations.slice(0, 10).map((d) => (<tr key={d.id}><td className="py-1.5 text-gray-900 dark:text-gray-100 truncate max-w-[200px]">{d.pipeline_name || d.project}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(d.avg_ms)}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(d.p95_ms)}</td><td className="py-1.5 text-right tabular-nums">{d.executions}</td></tr>))}</tbody></table>
                        ) : <ReportEmpty text="No duration data yet" />}
                      </div>
                    </div>
                    <div className="card">
                      <SectionHeading>Stage Bottlenecks</SectionHeading>
                      {bottlenecks.length > 0 ? (
                        <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Stage</th><th className="pb-2 font-medium text-right">Avg</th><th className="pb-2 font-medium text-right">Max</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{bottlenecks.slice(0, 8).map((b) => (<tr key={`${b.id}-${b.stage_name}`}><td className="py-1.5"><span className="text-gray-900 dark:text-gray-100 truncate block max-w-[160px]">{b.stage_name}</span>{b.pipeline_name && <span className="text-xs text-gray-400 dark:text-gray-500">{b.pipeline_name}</span>}</td><td className="py-1.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{fmtMs(b.avg_ms)}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(b.max_ms)}</td></tr>))}</tbody></table>
                      ) : <ReportEmpty text="No bottleneck data yet" />}
                    </div>
                  </>
                )}
              </>
            )}

            {/* Failures */}
            {pipelineTab === 'failures' && (
              <>
                {loading && !hasFailData && <TwoColumnSkeleton />}
                {!loading && !hasFailData && <EmptyState icon={GitBranch} title="No failure data" description="No stage failures, action failures, or errors recorded for this period." illustration="pipelines" />}
                {hasFailData && (
                  <>
                    <div className="card">
                      <SectionHeading>Stage Failures</SectionHeading>
                      {stageFailures.length > 0 ? (
                        <div className="space-y-2.5">{stageFailures.slice(0, 8).map((s) => (<div key={s.stage_name}><div className="flex justify-between text-sm mb-1"><span className="text-gray-700 dark:text-gray-300 truncate">{s.stage_name}</span><span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums ml-2 shrink-0">{s.failure_pct}%</span></div><div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"><div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.min(s.failure_pct, 100)}%` }} /></div></div>))}</div>
                      ) : <ReportEmpty text="No stage failures" />}
                    </div>
                    {actionFailures.length > 0 && (
                      <div className="card">
                        <SectionHeading>Action Failures</SectionHeading>
                        <div className="space-y-2.5">{actionFailures.slice(0, 8).map((a) => (<div key={a.action_name}><div className="flex justify-between text-sm mb-1"><span className="text-gray-700 dark:text-gray-300 truncate font-mono text-xs">{a.action_name}</span><span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums ml-2 shrink-0">{a.failures}/{a.total} ({a.failure_pct}%)</span></div><div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"><div className="h-full bg-orange-500 rounded-full" style={{ width: `${Math.min(a.failure_pct, 100)}%` }} /></div></div>))}</div>
                      </div>
                    )}
                    <div className="card">
                      <div className="flex items-center justify-between mb-3">
                        <SectionHeading>Top Errors</SectionHeading>
                        <ExportCSVButton data={errors.map(e => ({ pattern: e.error_pattern, occurrences: e.occurrences, pipelines: e.affected_pipelines, last_seen: e.last_seen }))} filename="pipeline-errors" />
                      </div>
                      {errors.length > 0 ? (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3">{errors.slice(0, 8).map((e, i) => (<div key={i} className="border-l-2 border-red-400 pl-3"><p className="text-sm text-gray-900 dark:text-gray-100 line-clamp-1">{e.error_pattern}</p><p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{e.occurrences}x &middot; {e.affected_pipelines} pipeline{e.affected_pipelines !== 1 ? 's' : ''} &middot; {fmtDate(e.last_seen)}</p></div>))}</div>
                      ) : <ReportEmpty text="No errors recorded" />}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* ═══════════════════ PLUGINS ═══════════════════ */}
        {topTab === 'plugins' && (
          <>
            <ReportTabs tabs={PLUGIN_TABS} activeTab={pluginTab} onTabChange={(id) => setPluginTab(id as PluginSubTab)} />

            {/* Overview */}
            {pluginTab === 'overview' && (
              <>
                {loading && !hasPluginOverview && <StatCardSkeleton count={5} />}
                {!loading && !hasPluginOverview && <EmptyState icon={Puzzle} title="No plugin data yet" description="Create and build plugins to see inventory stats and distribution here." illustration="plugins" />}
                {hasPluginOverview && pluginSummary && (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
                      {[
                        { label: 'Total', value: pluginSummary.total },
                        { label: 'Active', value: pluginSummary.active },
                        { label: 'Inactive', value: pluginSummary.inactive },
                        { label: 'Public', value: pluginSummary.public },
                        { label: 'Private', value: pluginSummary.private },
                      ].map((s) => (
                        <div key={s.label} className="card py-4 text-center">
                          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.value}</p>
                          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{s.label}</p>
                        </div>
                      ))}
                    </div>
                    {Object.keys(typeDistribution).length > 0 && (
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="card">
                          <SectionHeading>By Plugin Type</SectionHeading>
                          <div className="space-y-2">{Object.entries(typeDistribution).sort((a, b) => b[1] - a[1]).map(([type, count]) => (<div key={type} className="flex items-center gap-3"><span className="text-sm text-gray-700 dark:text-gray-300 w-36 truncate">{type}</span><div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden"><div className="h-full bg-blue-500/70 rounded" style={{ width: `${(count / maxDistCount) * 100}%` }} /></div><span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums w-8 text-right">{count}</span></div>))}</div>
                        </div>
                        <div className="card">
                          <SectionHeading>By Compute Type</SectionHeading>
                          <div className="space-y-2">{Object.entries(computeDistribution).sort((a, b) => b[1] - a[1]).map(([type, count]) => (<div key={type} className="flex items-center gap-3"><span className="text-sm text-gray-700 dark:text-gray-300 w-36 truncate">{type}</span><div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden"><div className="h-full bg-purple-500/70 rounded" style={{ width: `${(count / maxDistCount) * 100}%` }} /></div><span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums w-8 text-right">{count}</span></div>))}</div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {/* Builds */}
            {pluginTab === 'builds' && (
              <>
                {loading && !hasBuildsData && <TwoColumnSkeleton />}
                {!loading && !hasBuildsData && <EmptyState icon={Puzzle} title="No build data yet" description="Build some plugins to see success rates, durations, and failures." illustration="plugins" />}
                {hasBuildsData && (
                  <>
                    {buildTimeline.length > 0 && (
                      <div className="card">
                        <SectionHeading>Build Success Rate</SectionHeading>
                        <div className="space-y-1.5">
                          {buildTimeline.map((entry) => {
                            const total = entry.succeeded + entry.failed;
                            const sPct = total > 0 ? (entry.succeeded / total) * 100 : 0;
                            const fPct = total > 0 ? (entry.failed / total) * 100 : 0;
                            return (
                              <div key={entry.period} className="flex items-center gap-3">
                                <span className="text-xs text-gray-400 dark:text-gray-500 w-16 shrink-0 tabular-nums">{fmtDate(entry.period)}</span>
                                <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden flex">
                                  {sPct > 0 && <div className="h-full bg-green-500" style={{ width: `${sPct}%` }} />}
                                  {fPct > 0 && <div className="h-full bg-red-500" style={{ width: `${fPct}%` }} />}
                                </div>
                                <span className="text-xs text-gray-400 dark:text-gray-500 w-12 text-right tabular-nums">{total}</span>
                              </div>
                            );
                          })}
                          <div className="flex items-center gap-2 mt-2"><Badge color="green">Pass</Badge><Badge color="red">Fail</Badge></div>
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <div className="card">
                        <SectionHeading>Build Duration</SectionHeading>
                        {buildDurations.length > 0 ? (
                          <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Plugin</th><th className="pb-2 font-medium text-right">Avg</th><th className="pb-2 font-medium text-right">Max</th><th className="pb-2 font-medium text-right">Builds</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{buildDurations.slice(0, 10).map((d) => (<tr key={d.plugin_name}><td className="py-1.5 text-gray-900 dark:text-gray-100 truncate max-w-[200px]">{d.plugin_name}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(d.avg_ms)}</td><td className="py-1.5 text-right tabular-nums">{fmtMs(d.max_ms)}</td><td className="py-1.5 text-right tabular-nums">{d.builds}</td></tr>))}</tbody></table>
                        ) : <ReportEmpty text="No build duration data yet" />}
                      </div>
                      <div className="card">
                        <SectionHeading>Recent Build Failures</SectionHeading>
                        {buildFailures.length > 0 ? (
                          <div className="space-y-3">{buildFailures.slice(0, 6).map((f, i) => (<div key={i} className="border-l-2 border-red-400 pl-3"><p className="text-sm text-gray-900 dark:text-gray-100">{f.plugin_name}</p><p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mt-0.5">{f.error_message}</p><p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{f.occurrences}x &middot; {fmtDate(f.last_seen)}</p></div>))}</div>
                        ) : <ReportEmpty text="No build failures" />}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {/* Versions */}
            {pluginTab === 'versions' && (
              <>
                {loading && !hasVersionsData && <SectionCardSkeleton lines={6} />}
                {!loading && !hasVersionsData && <EmptyState icon={Puzzle} title="No version data yet" description="Create plugins to see version tracking and freshness warnings." illustration="plugins" />}
                {hasVersionsData && (
                  <>
                    {stalePlugins.length > 0 && (
                      <div className="card border-amber-200/60 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-900/10">
                        <div className="flex items-start gap-3">
                          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                          <div>
                            <h3 className="text-sm font-medium text-amber-800 dark:text-amber-300">{stalePlugins.length} plugin{stalePlugins.length !== 1 ? 's' : ''} without a default version</h3>
                            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">{stalePlugins.map(p => p.name).join(', ')}</p>
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="card">
                      <div className="flex items-center justify-between mb-3">
                        <SectionHeading>Plugin Versions</SectionHeading>
                        <ExportCSVButton data={pluginVersions.map(v => ({ name: v.name, versions: v.version_count, latest: v.latest_version, has_default: v.has_default }))} filename="plugin-versions" />
                      </div>
                      <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700"><th className="pb-2 font-medium">Plugin</th><th className="pb-2 font-medium text-right">Versions</th><th className="pb-2 font-medium text-right">Latest</th><th className="pb-2 font-medium text-center">Default</th></tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">{pluginVersions.slice(0, 15).map((v) => (<tr key={v.name}><td className="py-1.5 text-gray-900 dark:text-gray-100">{v.name}</td><td className="py-1.5 text-right tabular-nums">{v.version_count}</td><td className="py-1.5 text-right font-mono text-xs">{v.latest_version}</td><td className="py-1.5 text-center">{v.has_default ? <span className="inline-block w-2 h-2 rounded-full bg-green-500" /> : <span className="inline-block w-2 h-2 rounded-full bg-amber-400" title="No default set" />}</td></tr>))}</tbody></table>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

      </motion.div>
    </DashboardLayout>
  );
}
