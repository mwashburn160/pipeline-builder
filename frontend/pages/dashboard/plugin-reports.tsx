import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
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

function ReportEmpty({ text }: { text: string }) {
  return <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">{text}</p>;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="section-title text-sm tracking-tight mb-3">{children}</h3>;
}

// ─── Page ───────────────────────────────────────────────

/** Plugin reports page. Inventory summary, version matrix, build success rate, duration, and failures. */
export default function PluginReportsPage() {
  const { user, isReady, isAuthenticated } = useAuthGuard();

  const [loading, setLoading] = useState(true);
  const [pluginSummary, setPluginSummary] = useState<PluginSummary | null>(null);
  const [pluginVersions, setPluginVersions] = useState<PluginVersion[]>([]);
  const [buildTimeline, setBuildTimeline] = useState<BuildSuccessEntry[]>([]);
  const [buildDurations, setBuildDurations] = useState<BuildDurationStat[]>([]);
  const [buildFailures, setBuildFailures] = useState<BuildFailure[]>([]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sumRes, verRes, timelineRes, durRes, failRes] = await Promise.allSettled([
        api.getPluginSummary(),
        api.getPluginVersions(),
        api.getBuildSuccessRate(),
        api.getBuildDuration(),
        api.getBuildFailures({ limit: 10 }),
      ]);

      if (sumRes.status === 'fulfilled') setPluginSummary(sumRes.value.data?.summary || null);
      if (verRes.status === 'fulfilled') setPluginVersions(verRes.value.data?.plugins || []);
      if (timelineRes.status === 'fulfilled') setBuildTimeline(timelineRes.value.data?.timeline || []);
      if (durRes.status === 'fulfilled') setBuildDurations(durRes.value.data?.plugins || []);
      if (failRes.status === 'fulfilled') setBuildFailures(failRes.value.data?.failures || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchAll();
  }, [isAuthenticated, fetchAll]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Plugin Reports"
      subtitle="Inventory, build analytics, and version tracking"
      maxWidth="7xl"
      actions={
        <button onClick={fetchAll} disabled={loading} className="btn btn-secondary px-3 py-1.5 text-sm">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      }
    >
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="page-section space-y-6">

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

        {/* ── Plugin Version Matrix ── */}
        <div className="card">
          <SectionHeading>Plugin Versions</SectionHeading>
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
            <ReportEmpty text="No plugin data yet" />
          )}
        </div>

      </motion.div>
    </DashboardLayout>
  );
}
