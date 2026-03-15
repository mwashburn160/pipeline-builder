import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import api from '@/lib/api';

// ─── Types ──────────────────────────────────────────────

interface ExecutionCount {
  id: string;
  project: string;
  organization: string;
  pipeline_name: string | null;
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  first_execution: string | null;
  last_execution: string | null;
}

interface TimelineEntry {
  period: string;
  succeeded: number;
  failed: number;
  canceled: number;
  success_pct: number;
}

interface DurationStat {
  id: string;
  project: string;
  pipeline_name: string | null;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  p95_ms: number;
  executions: number;
}

interface StageFailure {
  stage_name: string;
  failures: number;
  total: number;
  failure_pct: number;
}

interface ErrorEntry {
  error_pattern: string;
  occurrences: number;
  affected_pipelines: number;
  last_seen: string;
}

interface PluginSummary {
  total: number;
  active: number;
  inactive: number;
  public: number;
  private: number;
  unique_names: number;
}

interface PluginVersion {
  name: string;
  version_count: number;
  latest_version: string;
  has_default: boolean;
}

// ─── Helpers ────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">{text}</p>;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">{children}</h3>;
}

// ─── Page ───────────────────────────────────────────────

export default function ReportsPage() {
  const { user, isReady, isAuthenticated } = useAuthGuard();

  const [interval, setInterval_] = useState<'day' | 'week' | 'month'>('week');
  const [loading, setLoading] = useState(true);

  const [executions, setExecutions] = useState<ExecutionCount[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [durations, setDurations] = useState<DurationStat[]>([]);
  const [stageFailures, setStageFailures] = useState<StageFailure[]>([]);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [pluginSummary, setPluginSummary] = useState<PluginSummary | null>(null);
  const [pluginVersions, setPluginVersions] = useState<PluginVersion[]>([]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [execRes, timelineRes, durationRes, stageRes, errorRes, pluginSumRes, pluginVerRes] = await Promise.allSettled([
        api.getExecutionCount(),
        api.getExecutionTimeline({ interval }),
        api.getPipelineDuration(),
        api.getStageFailures(),
        api.getExecutionErrors({ limit: 10 }),
        api.getPluginSummary(),
        api.getPluginVersions(),
      ]);

      if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
      if (timelineRes.status === 'fulfilled') setTimeline(timelineRes.value.data?.timeline || []);
      if (durationRes.status === 'fulfilled') setDurations(durationRes.value.data?.pipelines || []);
      if (stageRes.status === 'fulfilled') setStageFailures(stageRes.value.data?.stages || []);
      if (errorRes.status === 'fulfilled') setErrors(errorRes.value.data?.errors || []);
      if (pluginSumRes.status === 'fulfilled') setPluginSummary(pluginSumRes.value.data?.summary || null);
      if (pluginVerRes.status === 'fulfilled') setPluginVersions(pluginVerRes.value.data?.plugins || []);
    } finally {
      setLoading(false);
    }
  }, [interval]);

  useEffect(() => {
    if (isAuthenticated) fetchAll();
  }, [isAuthenticated, fetchAll]);

  if (!isReady || !user) return null;

  const totalExec = executions.reduce((s, p) => s + p.total, 0);
  const totalPass = executions.reduce((s, p) => s + p.succeeded, 0);
  const totalFail = executions.reduce((s, p) => s + p.failed, 0);
  const successRate = totalExec > 0 ? ((totalPass / totalExec) * 100).toFixed(1) : '—';

  return (
    <DashboardLayout
      title="Reports"
      maxWidth="7xl"
      actions={
        <div className="flex items-center gap-2">
          <select
            value={interval}
            onChange={(e) => setInterval_(e.target.value as 'day' | 'week' | 'month')}
            className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
          >
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
          <button onClick={fetchAll} disabled={loading} className="btn btn-secondary px-3 py-1.5 text-sm">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      }
    >
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="space-y-6">

        {/* ── Summary row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Executions', value: totalExec },
            { label: 'Success Rate', value: successRate === '—' ? '—' : `${successRate}%` },
            { label: 'Failures', value: totalFail },
            { label: 'Plugins', value: pluginSummary ? `${pluginSummary.active}/${pluginSummary.total}` : '—' },
          ].map((s) => (
            <div key={s.label} className="card py-4 text-center">
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.value}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {/* ── Timeline ── */}
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
                      {sPct > 0 && <div className="h-full bg-green-500" style={{ width: `${sPct}%` }} title={`${sPct.toFixed(1)}% passed`} />}
                      {fPct > 0 && <div className="h-full bg-red-500" style={{ width: `${fPct}%` }} title={`${fPct.toFixed(1)}% failed`} />}
                      {cPct > 0 && <div className="h-full bg-yellow-400" style={{ width: `${cPct}%` }} title={`${cPct.toFixed(1)}% canceled`} />}
                    </div>
                    <span className="text-xs text-gray-400 dark:text-gray-500 w-12 text-right tabular-nums">{total}</span>
                  </div>
                );
              })}
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-400 dark:text-gray-500">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" /> Pass</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Fail</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400" /> Canceled</span>
              </div>
            </div>
          ) : (
            <EmptyState text="No execution data yet" />
          )}
        </div>

        {/* ── Pipelines + Duration ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card">
            <SectionHeading>Pipeline Executions</SectionHeading>
            {executions.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th className="pb-2 font-medium">Pipeline</th>
                    <th className="pb-2 font-medium text-right">Total</th>
                    <th className="pb-2 font-medium text-right">Pass</th>
                    <th className="pb-2 font-medium text-right">Fail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {executions.slice(0, 10).map((p) => (
                    <tr key={p.id}>
                      <td className="py-1.5 text-gray-900 dark:text-gray-100 truncate max-w-[200px]">{p.pipeline_name || p.project}</td>
                      <td className="py-1.5 text-right tabular-nums">{p.total}</td>
                      <td className="py-1.5 text-right tabular-nums text-green-600 dark:text-green-400">{p.succeeded}</td>
                      <td className="py-1.5 text-right tabular-nums text-red-600 dark:text-red-400">{p.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState text="No execution data yet" />
            )}
          </div>

          <div className="card">
            <SectionHeading>Pipeline Duration</SectionHeading>
            {durations.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th className="pb-2 font-medium">Pipeline</th>
                    <th className="pb-2 font-medium text-right">Avg</th>
                    <th className="pb-2 font-medium text-right">P95</th>
                    <th className="pb-2 font-medium text-right">Runs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {durations.slice(0, 10).map((d) => (
                    <tr key={d.id}>
                      <td className="py-1.5 text-gray-900 dark:text-gray-100 truncate max-w-[200px]">{d.pipeline_name || d.project}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtMs(d.avg_ms)}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtMs(d.p95_ms)}</td>
                      <td className="py-1.5 text-right tabular-nums">{d.executions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState text="No duration data yet" />
            )}
          </div>
        </div>

        {/* ── Failures + Errors ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card">
            <SectionHeading>Stage Failures</SectionHeading>
            {stageFailures.length > 0 ? (
              <div className="space-y-2.5">
                {stageFailures.slice(0, 8).map((s) => (
                  <div key={s.stage_name}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-700 dark:text-gray-300 truncate">{s.stage_name}</span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums ml-2 shrink-0">{s.failure_pct}%</span>
                    </div>
                    <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.min(s.failure_pct, 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState text="No stage failures" />
            )}
          </div>

          <div className="card">
            <SectionHeading>Top Errors</SectionHeading>
            {errors.length > 0 ? (
              <div className="space-y-3">
                {errors.slice(0, 6).map((e, i) => (
                  <div key={i} className="border-l-2 border-red-400 pl-3">
                    <p className="text-sm text-gray-900 dark:text-gray-100 line-clamp-1">{e.error_pattern}</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                      {e.occurrences}x &middot; {e.affected_pipelines} pipeline{e.affected_pipelines !== 1 ? 's' : ''} &middot; {fmtDate(e.last_seen)}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState text="No errors recorded" />
            )}
          </div>
        </div>

        {/* ── Plugin Inventory ── */}
        <div className="card">
          <SectionHeading>Plugin Inventory</SectionHeading>
          {pluginSummary && (
            <div className="flex flex-wrap gap-6 mb-4 text-center">
              {[
                { label: 'Total', value: pluginSummary.total },
                { label: 'Active', value: pluginSummary.active },
                { label: 'Public', value: pluginSummary.public },
                { label: 'Private', value: pluginSummary.private },
              ].map((item) => (
                <div key={item.label}>
                  <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{item.value}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">{item.label}</p>
                </div>
              ))}
            </div>
          )}
          {pluginVersions.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 font-medium">Plugin</th>
                  <th className="pb-2 font-medium text-right">Versions</th>
                  <th className="pb-2 font-medium text-right">Latest</th>
                  <th className="pb-2 font-medium text-center">Default</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {pluginVersions.slice(0, 15).map((v) => (
                  <tr key={v.name}>
                    <td className="py-1.5 text-gray-900 dark:text-gray-100">{v.name}</td>
                    <td className="py-1.5 text-right tabular-nums">{v.version_count}</td>
                    <td className="py-1.5 text-right font-mono text-xs">{v.latest_version}</td>
                    <td className="py-1.5 text-center">
                      <span className={`inline-block w-2 h-2 rounded-full ${v.has_default ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState text="No plugin data yet" />
          )}
        </div>

      </motion.div>
    </DashboardLayout>
  );
}
