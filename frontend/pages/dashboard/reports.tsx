import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { GitBranch, Puzzle, AlertTriangle } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Checkbox } from '@/components/ui/Checkbox';

const ReportTabs = dynamic(() => import('@/components/reports/ReportTabs'), {
  loading: () => <LoadingPage />,
});
import { DateRangePicker, AutoRefresh } from '@/components/reports/ReportHelpers';
import { PipelineOverview } from '@/components/reports/PipelineOverview';
import { PipelinePerformance } from '@/components/reports/PipelinePerformance';
import { PipelineFailures } from '@/components/reports/PipelineFailures';
import { PluginOverview } from '@/components/reports/PluginOverview';
import { PluginBuilds } from '@/components/reports/PluginBuilds';
import { PluginVersions } from '@/components/reports/PluginVersions';
import type {
  TimelineEntry, DurationStat, StageFailure, StageBottleneck, ErrorEntry, ActionFailure,
  PluginSummary, PluginVersion as PluginVersionRow, BuildSuccessEntry, BuildDurationStat, BuildFailure, PluginDistribution,
} from '@/components/reports/types';
import { useFeatures } from '@/hooks/useFeatures';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { ExecutionCountRow } from '@/types';
import type { DoraMetrics, DoraTrendPoint } from '@/lib/api/domains/reporting';

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

// Quick date-range presets. Each maps to a rolling window ending today; the
// bounds are computed client-side as `YYYY-MM-DD` (the format the native date
// inputs / backend from|to expect).
const DATE_PRESETS: { label: string; days: number }[] = [
  { label: 'Last 7d', days: 7 },
  { label: 'Last 30d', days: 30 },
  { label: 'Last 90d', days: 90 },
];

/** Format a Date as a local `YYYY-MM-DD` string (matches the native date input value). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Rolling window ending today, `days` back. */
function presetRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { from: isoDay(from), to: isoDay(to) };
}

// ─── Page ───────────────────────────────────────────────
export default function ReportsPage() {
  const { user, isReady, isAuthenticated, can } = useAuthGuard({ requirePermission: 'reports:read' });
  const router = useRouter();
  // DORA / advanced delivery analytics is a paid-tier entitlement. Gates both the
  // section render and the fetches (skip the request to avoid a pointless 403).
  const doraEnabled = useFeatures().isEnabled('advanced_reporting');

  const [topTab, setTopTab] = useState<TopTab>('pipelines');
  const [pipelineTab, setPipelineTab] = useState<PipelineSubTab>('overview');
  const [pluginTab, setPluginTab] = useState<PluginSubTab>('overview');

  // Honor ?tab=plugins|pipelines on load and on browser back/forward, so the
  // tab is deep-linkable (e.g. from the command palette or a shared URL).
  useEffect(() => {
    if (!router.isReady) return;
    const raw = router.query.tab;
    const tab = Array.isArray(raw) ? raw[0] : raw;
    if (tab === 'plugins' || tab === 'pipelines') {
      setTopTab((prev) => (prev === tab ? prev : tab));
    }
  }, [router.isReady, router.query.tab]);

  // Switch the top-level tab and reflect it in the URL (shallow — no data
  // refetch from the route change; the effects below already key off topTab).
  const changeTopTab = useCallback((id: TopTab) => {
    setTopTab(id);
    void router.replace(
      { pathname: router.pathname, query: { ...router.query, tab: id } },
      undefined,
      { shallow: true },
    );
  }, [router]);
  const [timeInterval, setTimeInterval] = useState<'day' | 'week' | 'month'>('week');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);
  // First fetch error for the active tab. `Promise.allSettled` never rejects, so
  // without this a backend failure would silently render as an empty state ("No
  // data yet") — indistinguishable from a genuinely empty dataset.
  const [error, setError] = useState<string | null>(null);
  // Org → team rollup: only admins/owners can aggregate child-team analytics, and
  // the toggle only appears when the org actually parents teams (flat orgs see no
  // extra control). Backend independently gates the rollup to admins.
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [hasTeams, setHasTeams] = useState(false);
  // Gate on the actual `reports:rollup` permission (a read-visibility scope), not a
  // hardcoded role — so a custom role granting it works and admins without it don't.
  const canRollup = can('reports:rollup');

  // Pipeline data
  const [executions, setExecutions] = useState<ExecutionCountRow[]>([]);
  // `timeline` feeds both the Execution Timeline and the Success Rate Trend —
  // they derive from the same success-rate response (was two identical slices).
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [dora, setDora] = useState<DoraMetrics | null>(null);
  const [doraTrend, setDoraTrend] = useState<DoraTrendPoint[]>([]);
  // DORA scoping (entitled users only). Empty pipeline/environment ⇒ omit the
  // param (backend defaults to org-wide, run-basis). `deploysOnly` flips the
  // basis to deployment-scoped when the pipeline emits deploy markers.
  const [doraPipelineId, setDoraPipelineId] = useState('');
  // `doraEnvironment` is the live input value; `doraEnvironmentApplied` is the
  // committed value that actually feeds the fetch. Typing updates only the
  // former (keeping the input responsive); a short debounce — plus an immediate
  // commit on blur/Enter — promotes it to the latter, so a request isn't fired
  // per keystroke (which would also reset the AutoRefresh timer each time).
  const [doraEnvironment, setDoraEnvironment] = useState('');
  const [doraEnvironmentApplied, setDoraEnvironmentApplied] = useState('');
  const [doraDeploysOnly, setDoraDeploysOnly] = useState(false);
  // Full pipeline list for the DORA per-pipeline picker — sourced from the
  // pipeline registry (not execution history), so a pipeline that exists but has
  // never run is still selectable. Merged with execution-derived names in
  // PipelineOverview so a since-deleted pipeline with historical events can also
  // be scoped. Fetched only when DORA is entitled.
  const [pipelineOptions, setPipelineOptions] = useState<{ id: string; name: string }[]>([]);
  // Deploy environments actually observed in the window — merged with sensible
  // defaults to seed the DORA environment datalist. Fetched only when entitled.
  const [environmentOptions, setEnvironmentOptions] = useState<string[]>([]);
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
  const [pluginVersions, setPluginVersions] = useState<PluginVersionRow[]>([]);
  const reqIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    // Request-generation guard: rapidly switching tabs/filters fires overlapping
    // fetches, and Promise.allSettled resolves regardless of order — without this
    // a slower, superseded response could overwrite the newer tab's slices. Only
    // the latest invocation is allowed to write state / clear `loading`.
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    // Collects the settled results of whichever branch runs, so a rejected fetch
    // can be surfaced as an error banner rather than silently dropped.
    let settled: PromiseSettledResult<unknown>[] = [];
    const dateParams: Record<string, string> = {};
    if (dateFrom) dateParams.from = dateFrom;
    if (dateTo) dateParams.to = dateTo;
    // Execution count, success-rate, duration and DORA all support a hierarchy
    // rollup (their backend queries accept the org subtree); the others
    // (bottlenecks, failures, plugin reports) are single-org. `rollup` is an
    // empty object when off so the param is omitted.
    const rollup = includeDescendants ? { includeDescendants: true } : {};

    try {
      if (topTab === 'pipelines') {
        if (pipelineTab === 'overview') {
          // `timeline` and `successRateTrend` both derive from the success-rate
          // response — fetch it once and feed both (was two identical requests).
          // DORA + its trend share this batch so they flow through the same
          // request-generation guard + error banner; when the feature is off we
          // resolve them locally (no HTTP call → no 403) while keeping the tuple
          // shape stable.
          // DORA scoping filters — omit each param when unset so the backend
          // keeps its org-wide, run-basis default. `deploysOnly` narrows the
          // basis to deployment-scoped counting.
          const doraScope: { pipelineId?: string; environment?: string; deploysOnly?: boolean } = {};
          if (doraPipelineId) doraScope.pipelineId = doraPipelineId;
          if (doraEnvironmentApplied.trim()) doraScope.environment = doraEnvironmentApplied.trim();
          if (doraDeploysOnly) doraScope.deploysOnly = true;
          const doraReq = doraEnabled
            ? api.getDora({ ...dateParams, ...rollup, ...doraScope })
            : Promise.resolve<DoraMetrics | undefined>(undefined);
          const doraTrendReq = doraEnabled
            ? api.getDoraTrend({ interval: timeInterval, ...dateParams, ...rollup, ...doraScope })
            : Promise.resolve<DoraTrendPoint[]>([]);
          // Populate the per-pipeline picker from the registry (all pipelines,
          // run or not). Ungated by date range; the picker is auxiliary, so a
          // failure here must NOT trip the shared error banner — swallow it to
          // `undefined` rather than letting it surface as a rejected slice.
          const pipelineListReq = doraEnabled
            ? api.listPipelines({ limit: '200' }).catch(() => undefined)
            : Promise.resolve(undefined);
          // Distinct environments observed in the window — seeds the env
          // datalist. Auxiliary like the pipeline picker, so swallow failures.
          const envListReq = doraEnabled
            ? api.getReportEnvironments({ ...dateParams, ...rollup }).catch(() => undefined)
            : Promise.resolve(undefined);
          const results = await Promise.allSettled([
            api.getExecutionCount({ ...dateParams, ...rollup }), api.getSuccessRate({ interval: timeInterval, ...dateParams, ...rollup }),
            doraReq, doraTrendReq, pipelineListReq, envListReq,
          ]);
          if (reqId !== reqIdRef.current) return;
          settled = results;
          const [execRes, successRateRes, doraRes, doraTrendRes, pipelineListRes, envListRes] = results;
          if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
          if (successRateRes.status === 'fulfilled') setTimeline(successRateRes.value.data?.timeline || []);
          if (doraRes.status === 'fulfilled') setDora(doraRes.value ?? null);
          if (doraTrendRes.status === 'fulfilled') setDoraTrend(doraTrendRes.value ?? []);
          if (pipelineListRes.status === 'fulfilled' && pipelineListRes.value) {
            setPipelineOptions(
              (pipelineListRes.value.data?.pipelines ?? []).map((p) => ({ id: p.id, name: p.pipelineName || p.project })),
            );
          }
          if (envListRes.status === 'fulfilled' && envListRes.value) {
            setEnvironmentOptions(envListRes.value.data?.environments ?? []);
          }
        } else if (pipelineTab === 'performance') {
          const results = await Promise.allSettled([
            api.getExecutionCount({ ...dateParams, ...rollup }), api.getPipelineDuration({ ...dateParams, ...rollup }), api.getStageBottlenecks(dateParams),
          ]);
          if (reqId !== reqIdRef.current) return;
          settled = results;
          const [execRes, durationRes, bottleneckRes] = results;
          if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
          if (durationRes.status === 'fulfilled') setDurations(durationRes.value.data?.pipelines || []);
          if (bottleneckRes.status === 'fulfilled') setBottlenecks(bottleneckRes.value.data?.stages || []);
        } else {
          const results = await Promise.allSettled([
            api.getStageFailures(dateParams), api.getActionFailures(dateParams), api.getExecutionErrors({ limit: 10, ...dateParams }),
          ]);
          if (reqId !== reqIdRef.current) return;
          settled = results;
          const [stageRes, actionRes, errorRes] = results;
          if (stageRes.status === 'fulfilled') setStageFailures(stageRes.value.data?.stages || []);
          if (actionRes.status === 'fulfilled') setActionFailures(actionRes.value.data?.actions || []);
          if (errorRes.status === 'fulfilled') setErrors(errorRes.value.data?.errors || []);
        }
      } else {
        if (pluginTab === 'overview') {
          const results = await Promise.allSettled([api.getPluginSummary(), api.getPluginDistribution()]);
          if (reqId !== reqIdRef.current) return;
          settled = results;
          const [sumRes, distRes] = results;
          if (sumRes.status === 'fulfilled') setPluginSummary(sumRes.value.data?.summary || null);
          if (distRes.status === 'fulfilled') setDistribution(distRes.value.data?.distribution || []);
        } else if (pluginTab === 'builds') {
          const results = await Promise.allSettled([
            api.getBuildSuccessRate({ interval: timeInterval, ...dateParams }), api.getBuildDuration(dateParams), api.getBuildFailures({ limit: 10, ...dateParams }),
          ]);
          if (reqId !== reqIdRef.current) return;
          settled = results;
          const [timelineRes, durRes, failRes] = results;
          if (timelineRes.status === 'fulfilled') setBuildTimeline(timelineRes.value.data?.timeline || []);
          if (durRes.status === 'fulfilled') setBuildDurations(durRes.value.data?.plugins || []);
          if (failRes.status === 'fulfilled') setBuildFailures(failRes.value.data?.failures || []);
        } else {
          const results = await Promise.allSettled([api.getPluginVersions()]);
          if (reqId !== reqIdRef.current) return;
          settled = results;
          const [verRes] = results;
          if (verRes.status === 'fulfilled') setPluginVersions(verRes.value.data?.plugins || []);
        }
      }
      // Surface the first rejected fetch so a backend failure shows a retry
      // banner instead of masquerading as an empty ("No data yet") state.
      const firstRejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (firstRejected) setError(formatError(firstRejected.reason, 'Failed to load report data'));
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [topTab, pipelineTab, pluginTab, timeInterval, dateFrom, dateTo, includeDescendants, doraEnabled, doraPipelineId, doraEnvironmentApplied, doraDeploysOnly]);

  useEffect(() => {
    if (isAuthenticated) fetchData();
  }, [isAuthenticated, fetchData]);

  // Debounce the environment filter: promote the live input to the committed
  // value ~400ms after typing stops (blur/Enter commit immediately via the
  // control), so each keystroke doesn't fire its own getDora/getDoraTrend pair.
  useEffect(() => {
    if (doraEnvironment === doraEnvironmentApplied) return;
    const t = setTimeout(() => setDoraEnvironmentApplied(doraEnvironment), 400);
    return () => clearTimeout(t);
  }, [doraEnvironment, doraEnvironmentApplied]);

  // Detect whether the active org parents any teams (subtree larger than self),
  // so the rollup toggle only shows when there's something to roll up.
  useEffect(() => {
    if (!isReady || !user || !canRollup || !user.organizationId) return;
    let cancelled = false;
    void api.getOrganizationDescendants(user.organizationId)
      .then((res) => { if (!cancelled) setHasTeams((res.data?.orgIds?.length ?? 0) > 1); })
      .catch(() => { /* best-effort — no toggle if it fails */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, user, canRollup]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Reports"
      subtitle="Pipeline execution analytics and plugin build insights"
      maxWidth="7xl"
      actions={
        <div className="flex items-center gap-3">
          {canRollup && hasTeams && topTab === 'pipelines' && (
            <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300" title="Aggregate pipeline analytics across this organization and its teams">
              <Checkbox
                checked={includeDescendants}
                onChange={(e) => setIncludeDescendants(e.target.checked)}
              />
              Include child teams
            </label>
          )}
          {/* Quick presets — set the same dateFrom/dateTo the manual picker drives.
              The active preset (whose rolling window matches the current bounds) is
              highlighted. */}
          <div className="flex items-center gap-1">
            {DATE_PRESETS.map((p) => {
              const range = presetRange(p.days);
              const active = dateFrom === range.from && dateTo === range.to;
              return (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => { setDateFrom(range.from); setDateTo(range.to); }}
                  aria-pressed={active}
                  className={`px-2 py-1 text-xs font-medium rounded-lg transition-colors ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                  title={`Show the last ${p.days} days`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
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
                onClick={() => changeTopTab(tab.id)}
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

        {/* Inline error + retry — a failed fetch would otherwise look like empty data. */}
        {error && !loading && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-sm text-red-700 dark:text-red-300">
            <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</span>
            <button onClick={fetchData} className="underline hover:no-underline shrink-0">Retry</button>
          </div>
        )}

        {/* ═══════════════════ PIPELINES ═══════════════════ */}
        {topTab === 'pipelines' && (
          <>
            <ReportTabs tabs={PIPELINE_TABS} activeTab={pipelineTab} onTabChange={(id) => setPipelineTab(id as PipelineSubTab)} />

            {pipelineTab === 'overview' && (
              <PipelineOverview
                loading={loading}
                executions={executions}
                pipelineOptions={pipelineOptions}
                environmentOptions={environmentOptions}
                timeline={timeline}
                dora={dora}
                doraTrend={doraTrend}
                doraEnabled={doraEnabled}
                doraScope={{
                  pipelineId: doraPipelineId,
                  environment: doraEnvironment,
                  deploysOnly: doraDeploysOnly,
                  onPipelineChange: setDoraPipelineId,
                  onEnvironmentChange: setDoraEnvironment,
                  onEnvironmentCommit: setDoraEnvironmentApplied,
                  onDeploysOnlyChange: setDoraDeploysOnly,
                }}
              />
            )}

            {pipelineTab === 'performance' && (
              <PipelinePerformance loading={loading} executions={executions} durations={durations} bottlenecks={bottlenecks} />
            )}

            {pipelineTab === 'failures' && (
              <PipelineFailures loading={loading} stageFailures={stageFailures} actionFailures={actionFailures} errors={errors} />
            )}
          </>
        )}

        {/* ═══════════════════ PLUGINS ═══════════════════ */}
        {topTab === 'plugins' && (
          <>
            <ReportTabs tabs={PLUGIN_TABS} activeTab={pluginTab} onTabChange={(id) => setPluginTab(id as PluginSubTab)} />

            {pluginTab === 'overview' && (
              <PluginOverview loading={loading} pluginSummary={pluginSummary} distribution={distribution} />
            )}

            {pluginTab === 'builds' && (
              <PluginBuilds loading={loading} buildTimeline={buildTimeline} buildDurations={buildDurations} buildFailures={buildFailures} />
            )}

            {pluginTab === 'versions' && (
              <PluginVersions loading={loading} pluginVersions={pluginVersions} />
            )}
          </>
        )}

      </motion.div>
    </DashboardLayout>
  );
}
