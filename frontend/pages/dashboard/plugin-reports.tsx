import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Puzzle, AlertTriangle } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  fmtMs, fmtDate, ReportEmpty, SectionHeading,
  StatCardSkeleton, SectionCardSkeleton, TwoColumnSkeleton,
  AutoRefresh, ExportCSVButton,
} from '@/components/reports/ReportHelpers';
import api from '@/lib/api';

// ─── Types ──────────────────────────────────────────────

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

interface BuildSuccessEntry {
  period: string;
  succeeded: number;
  failed: number;
  success_pct: number;
}

interface BuildDurationStat {
  plugin_name: string;
  avg_ms: number;
  max_ms: number;
  builds: number;
}

interface BuildFailure {
  plugin_name: string;
  error_message: string;
  occurrences: number;
  last_seen: string;
}

interface PluginDistribution {
  plugin_type: string;
  compute_type: string;
  count: number;
}

// ─── Page ───────────────────────────────────────────────

/** Plugin reports page. Inventory, build analytics, distribution, and version tracking. */
export default function PluginReportsPage() {
  const { user, isReady, isAuthenticated } = useAuthGuard();

  const [loading, setLoading] = useState(true);
  const [pluginSummary, setPluginSummary] = useState<PluginSummary | null>(null);
  const [pluginVersions, setPluginVersions] = useState<PluginVersion[]>([]);
  const [buildTimeline, setBuildTimeline] = useState<BuildSuccessEntry[]>([]);
  const [buildDurations, setBuildDurations] = useState<BuildDurationStat[]>([]);
  const [buildFailures, setBuildFailures] = useState<BuildFailure[]>([]);
  const [distribution, setDistribution] = useState<PluginDistribution[]>([]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sumRes, verRes, timelineRes, durRes, failRes, distRes] = await Promise.allSettled([
        api.getPluginSummary(),
        api.getPluginVersions(),
        api.getBuildSuccessRate(),
        api.getBuildDuration(),
        api.getBuildFailures({ limit: 10 }),
        api.getPluginDistribution(),
      ]);

      if (sumRes.status === 'fulfilled') setPluginSummary(sumRes.value.data?.summary || null);
      if (verRes.status === 'fulfilled') setPluginVersions(verRes.value.data?.plugins || []);
      if (timelineRes.status === 'fulfilled') setBuildTimeline(timelineRes.value.data?.timeline || []);
      if (durRes.status === 'fulfilled') setBuildDurations(durRes.value.data?.plugins || []);
      if (failRes.status === 'fulfilled') setBuildFailures(failRes.value.data?.failures || []);
      if (distRes.status === 'fulfilled') setDistribution(distRes.value.data?.distribution || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchAll();
  }, [isAuthenticated, fetchAll]);

  if (!isReady || !user) return <LoadingPage />;

  const hasData = pluginSummary !== null || pluginVersions.length > 0;

  // Group distribution by plugin_type for a simple bar visualization
  const typeDistribution = distribution.reduce<Record<string, number>>((acc, d) => {
    acc[d.plugin_type] = (acc[d.plugin_type] || 0) + d.count;
    return acc;
  }, {});
  const computeDistribution = distribution.reduce<Record<string, number>>((acc, d) => {
    acc[d.compute_type] = (acc[d.compute_type] || 0) + d.count;
    return acc;
  }, {});
  const maxDistCount = Math.max(1, ...Object.values(typeDistribution), ...Object.values(computeDistribution));

  // Version freshness — flag plugins with no default set
  const stalePlugins = pluginVersions.filter(v => !v.has_default);

  return (
    <DashboardLayout
      title="Plugin Reports"
      subtitle="Inventory, build analytics, and version tracking"
      maxWidth="7xl"
      actions={
        <AutoRefresh onRefresh={fetchAll} loading={loading} />
      }
    >
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="page-section space-y-6">

        {/* Loading skeletons */}
        {loading && !hasData && (
          <>
            <StatCardSkeleton count={5} />
            <SectionCardSkeleton lines={5} />
            <TwoColumnSkeleton />
            <SectionCardSkeleton lines={6} />
          </>
        )}

        {/* Empty state */}
        {!loading && !hasData && (
          <EmptyState
            icon={Puzzle}
            title="No plugin data yet"
            description="Create and build plugins to see inventory stats, build analytics, and version tracking here."
            illustration="plugins"
          />
        )}

        {/* Actual content */}
        {hasData && (
          <>
            {/* ── Summary row ── */}
            {pluginSummary && (
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
            )}

            {/* ── Distribution ── */}
            {Object.keys(typeDistribution).length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="card">
                  <SectionHeading>By Plugin Type</SectionHeading>
                  <div className="space-y-2">
                    {Object.entries(typeDistribution).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                      <div key={type} className="flex items-center gap-3">
                        <span className="text-sm text-gray-700 dark:text-gray-300 w-36 truncate">{type}</span>
                        <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
                          <div className="h-full bg-blue-500/70 rounded" style={{ width: `${(count / maxDistCount) * 100}%` }} />
                        </div>
                        <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums w-8 text-right">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card">
                  <SectionHeading>By Compute Type</SectionHeading>
                  <div className="space-y-2">
                    {Object.entries(computeDistribution).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                      <div key={type} className="flex items-center gap-3">
                        <span className="text-sm text-gray-700 dark:text-gray-300 w-36 truncate">{type}</span>
                        <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
                          <div className="h-full bg-purple-500/70 rounded" style={{ width: `${(count / maxDistCount) * 100}%` }} />
                        </div>
                        <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums w-8 text-right">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── Build Success Timeline ── */}
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
                          {sPct > 0 && <div className="h-full bg-green-500" style={{ width: `${sPct}%` }} title={`${sPct.toFixed(1)}% passed`} />}
                          {fPct > 0 && <div className="h-full bg-red-500" style={{ width: `${fPct}%` }} title={`${fPct.toFixed(1)}% failed`} />}
                        </div>
                        <span className="text-xs text-gray-400 dark:text-gray-500 w-12 text-right tabular-nums">{total}</span>
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2 mt-2">
                    <Badge color="green">Pass</Badge>
                    <Badge color="red">Fail</Badge>
                  </div>
                </div>
              </div>
            )}

            {/* ── Build Duration + Failures ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="card">
                <SectionHeading>Build Duration</SectionHeading>
                {buildDurations.length > 0 ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700">
                        <th className="pb-2 font-medium">Plugin</th>
                        <th className="pb-2 font-medium text-right">Avg</th>
                        <th className="pb-2 font-medium text-right">Max</th>
                        <th className="pb-2 font-medium text-right">Builds</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {buildDurations.slice(0, 10).map((d) => (
                        <tr key={d.plugin_name}>
                          <td className="py-1.5 text-gray-900 dark:text-gray-100 truncate max-w-[200px]">{d.plugin_name}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtMs(d.avg_ms)}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtMs(d.max_ms)}</td>
                          <td className="py-1.5 text-right tabular-nums">{d.builds}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <ReportEmpty text="No build duration data yet" />
                )}
              </div>

              <div className="card">
                <SectionHeading>Recent Build Failures</SectionHeading>
                {buildFailures.length > 0 ? (
                  <div className="space-y-3">
                    {buildFailures.slice(0, 6).map((f, i) => (
                      <div key={i} className="border-l-2 border-red-400 pl-3">
                        <p className="text-sm text-gray-900 dark:text-gray-100">{f.plugin_name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mt-0.5">{f.error_message}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          {f.occurrences}x &middot; {fmtDate(f.last_seen)}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <ReportEmpty text="No build failures" />
                )}
              </div>
            </div>

            {/* ── Version Freshness Warning ── */}
            {stalePlugins.length > 0 && (
              <div className="card border-amber-200/60 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-900/10">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-medium text-amber-800 dark:text-amber-300">
                      {stalePlugins.length} plugin{stalePlugins.length !== 1 ? 's' : ''} without a default version
                    </h3>
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                      {stalePlugins.map(p => p.name).join(', ')}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* ── Plugin Version Matrix ── */}
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <SectionHeading>Plugin Versions</SectionHeading>
                <ExportCSVButton
                  data={pluginVersions.map(v => ({ name: v.name, versions: v.version_count, latest: v.latest_version, has_default: v.has_default }))}
                  filename="plugin-versions"
                />
              </div>
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
                          {v.has_default ? (
                            <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                          ) : (
                            <span className="inline-block w-2 h-2 rounded-full bg-amber-400" title="No default set" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <ReportEmpty text="No plugin data yet" />
              )}
            </div>
          </>
        )}

      </motion.div>
    </DashboardLayout>
  );
}
