import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { BarChart3, TrendingUp, AlertTriangle, Clock, Puzzle, RefreshCw } from 'lucide-react';
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
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtPeriod(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Sub-components ─────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon, color }: { label: string; value: string | number; sub?: string; icon: React.ComponentType<{ className?: string }>; color: string }) {
  return (
    <div className="card flex items-start gap-4">
      <div className={`p-2.5 rounded-lg ${color}`}>
        <Icon className="w-5 h-5 text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
        {sub && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function BarSegment({ pct, color, label }: { pct: number; color: string; label: string }) {
  return pct > 0 ? (
    <div
      className={`h-full ${color} transition-all duration-500`}
      style={{ width: `${pct}%` }}
      title={`${label}: ${pct.toFixed(1)}%`}
    />
  ) : null;
}

// ─── Page ───────────────────────────────────────────────

export default function ReportsPage() {
  const { user, isReady, isAuthenticated } = useAuthGuard();

  const [interval, setInterval_] = useState<'day' | 'week' | 'month'>('week');
  const [loading, setLoading] = useState(true);

  // Execution data
  const [executions, setExecutions] = useState<ExecutionCount[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [durations, setDurations] = useState<DurationStat[]>([]);
  const [stageFailures, setStageFailures] = useState<StageFailure[]>([]);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);

  // Plugin data
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

  // Aggregate stats
  const totalExecutions = executions.reduce((s, p) => s + p.total, 0);
  const totalSucceeded = executions.reduce((s, p) => s + p.succeeded, 0);
  const totalFailed = executions.reduce((s, p) => s + p.failed, 0);
  const overallSuccessRate = totalExecutions > 0 ? ((totalSucceeded / totalExecutions) * 100).toFixed(1) : '—';

  return (
    <DashboardLayout title="Reports" maxWidth="7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Reports</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Pipeline execution and plugin analytics</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={interval}
            onChange={(e) => setInterval_(e.target.value as 'day' | 'week' | 'month')}
            className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
          >
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
          <button
            onClick={fetchAll}
            disabled={loading}
            className="btn btn-secondary px-3 py-1.5 text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Summary Stats */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8"
      >
        <StatCard label="Total Executions" value={totalExecutions} icon={BarChart3} color="bg-blue-500" />
        <StatCard label="Success Rate" value={overallSuccessRate === '—' ? '—' : `${overallSuccessRate}%`} icon={TrendingUp} color="bg-green-500" />
        <StatCard label="Failed Executions" value={totalFailed} icon={AlertTriangle} color="bg-red-500" />
        <StatCard label="Plugins" value={pluginSummary?.total ?? '—'} sub={pluginSummary ? `${pluginSummary.active} active` : undefined} icon={Puzzle} color="bg-purple-500" />
      </motion.div>

      {/* Execution Timeline */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        className="card mb-6"
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">Execution Timeline</h3>
        {timeline.length > 0 ? (
          <div className="space-y-2">
            {timeline.map((entry) => {
              const total = entry.succeeded + entry.failed + entry.canceled;
              const sPct = total > 0 ? (entry.succeeded / total) * 100 : 0;
              const fPct = total > 0 ? (entry.failed / total) * 100 : 0;
              const cPct = total > 0 ? (entry.canceled / total) * 100 : 0;
              return (
                <div key={entry.period} className="flex items-center gap-3">
                  <span className="text-xs text-gray-500 dark:text-gray-400 w-20 shrink-0 tabular-nums">{fmtPeriod(entry.period)}</span>
                  <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden flex">
                    <BarSegment pct={sPct} color="bg-green-500" label="Succeeded" />
                    <BarSegment pct={fPct} color="bg-red-500" label="Failed" />
                    <BarSegment pct={cPct} color="bg-yellow-500" label="Canceled" />
                  </div>
                  <span className="text-xs text-gray-500 dark:text-gray-400 w-16 text-right tabular-nums">{total} runs</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">No execution data available yet.</p>
        )}
        <div className="flex items-center gap-4 mt-3 text-xs text-gray-400 dark:text-gray-500">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> Succeeded</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> Failed</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-yellow-500 inline-block" /> Canceled</span>
        </div>
      </motion.div>

      {/* Two-column: Pipeline Executions + Duration */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Pipeline Execution Counts */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="card"
        >
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">Pipeline Execution Counts</h3>
          {executions.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="pb-2 font-medium">Pipeline</th>
                    <th className="pb-2 font-medium text-right">Total</th>
                    <th className="pb-2 font-medium text-right">Pass</th>
                    <th className="pb-2 font-medium text-right">Fail</th>
                    <th className="pb-2 font-medium text-right">Last Run</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {executions.slice(0, 10).map((p) => (
                    <tr key={p.id}>
                      <td className="py-2 text-gray-900 dark:text-gray-100 truncate max-w-[180px]">{p.pipeline_name || p.project}</td>
                      <td className="py-2 text-right tabular-nums">{p.total}</td>
                      <td className="py-2 text-right tabular-nums text-green-600 dark:text-green-400">{p.succeeded}</td>
                      <td className="py-2 text-right tabular-nums text-red-600 dark:text-red-400">{p.failed}</td>
                      <td className="py-2 text-right text-xs text-gray-500 dark:text-gray-400">{fmtDate(p.last_execution)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">No execution data yet.</p>
          )}
        </motion.div>

        {/* Pipeline Duration */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
          className="card"
        >
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Pipeline Duration</h3>
          </div>
          {durations.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="pb-2 font-medium">Pipeline</th>
                    <th className="pb-2 font-medium text-right">Avg</th>
                    <th className="pb-2 font-medium text-right">P95</th>
                    <th className="pb-2 font-medium text-right">Max</th>
                    <th className="pb-2 font-medium text-right">Runs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {durations.slice(0, 10).map((d) => (
                    <tr key={d.id}>
                      <td className="py-2 text-gray-900 dark:text-gray-100 truncate max-w-[180px]">{d.pipeline_name || d.project}</td>
                      <td className="py-2 text-right tabular-nums">{fmtMs(d.avg_ms)}</td>
                      <td className="py-2 text-right tabular-nums">{fmtMs(d.p95_ms)}</td>
                      <td className="py-2 text-right tabular-nums">{fmtMs(d.max_ms)}</td>
                      <td className="py-2 text-right tabular-nums">{d.executions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">No duration data yet.</p>
          )}
        </motion.div>
      </div>

      {/* Two-column: Stage Failures + Errors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Stage Failures */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
          className="card"
        >
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Stage Failures</h3>
          </div>
          {stageFailures.length > 0 ? (
            <div className="space-y-3">
              {stageFailures.slice(0, 8).map((s) => (
                <div key={s.stage_name}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-gray-700 dark:text-gray-300 truncate">{s.stage_name}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{s.failures}/{s.total} ({s.failure_pct}%)</span>
                  </div>
                  <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-red-500 rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(s.failure_pct, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">No stage failure data yet.</p>
          )}
        </motion.div>

        {/* Recent Errors */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.25 }}
          className="card"
        >
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">Top Errors</h3>
          {errors.length > 0 ? (
            <div className="space-y-3">
              {errors.slice(0, 6).map((e, i) => (
                <div key={i} className="border-l-2 border-red-400 pl-3">
                  <p className="text-sm text-gray-900 dark:text-gray-100 line-clamp-2">{e.error_pattern}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
                    <span>{e.occurrences} occurrence{e.occurrences !== 1 ? 's' : ''}</span>
                    <span>{e.affected_pipelines} pipeline{e.affected_pipelines !== 1 ? 's' : ''}</span>
                    <span>Last: {fmtDate(e.last_seen)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">No errors recorded.</p>
          )}
        </motion.div>
      </div>

      {/* Plugin Inventory */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.3 }}
        className="card"
      >
        <div className="flex items-center gap-2 mb-4">
          <Puzzle className="w-4 h-4 text-purple-400" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Plugin Inventory</h3>
        </div>

        {pluginSummary ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
            {[
              { label: 'Total', value: pluginSummary.total },
              { label: 'Active', value: pluginSummary.active },
              { label: 'Inactive', value: pluginSummary.inactive },
              { label: 'Public', value: pluginSummary.public },
              { label: 'Private', value: pluginSummary.private },
              { label: 'Unique', value: pluginSummary.unique_names },
            ].map((item) => (
              <div key={item.label} className="text-center">
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{item.value}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{item.label}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-6 gap-4 mb-6">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="text-center">
                <div className="h-7 skeleton w-12 mx-auto mb-1" />
                <div className="h-3 skeleton w-16 mx-auto" />
              </div>
            ))}
          </div>
        )}

        {pluginVersions.length > 0 && (
          <>
            <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Version Details</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="pb-2 font-medium">Plugin</th>
                    <th className="pb-2 font-medium text-right">Versions</th>
                    <th className="pb-2 font-medium text-right">Latest</th>
                    <th className="pb-2 font-medium text-center">Default</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {pluginVersions.slice(0, 15).map((v) => (
                    <tr key={v.name}>
                      <td className="py-2 text-gray-900 dark:text-gray-100">{v.name}</td>
                      <td className="py-2 text-right tabular-nums">{v.version_count}</td>
                      <td className="py-2 text-right font-mono text-xs">{v.latest_version}</td>
                      <td className="py-2 text-center">
                        {v.has_default ? (
                          <span className="inline-block w-2 h-2 rounded-full bg-green-500" title="Has default" />
                        ) : (
                          <span className="inline-block w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600" title="No default" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </motion.div>
    </DashboardLayout>
  );
}
