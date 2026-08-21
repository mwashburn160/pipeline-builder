import { useRouter } from 'next/router';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { GitBranch, Puzzle, AlertTriangle, Gauge } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Checkbox } from '@/components/ui/Checkbox';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { DateRangePicker, AutoRefresh } from '@/components/reports/ReportHelpers';
import { PipelinesTab } from '@/components/reports/tabs/PipelinesTab';
import { PluginsTab } from '@/components/reports/tabs/PluginsTab';
import { DoraTab } from '@/components/reports/tabs/DoraTab';
import {
  useReportRetention, type SharedFilters, type TabDataStatus,
} from '@/components/reports/useReportData';
import { useFeatures } from '@/hooks/useFeatures';
import api from '@/lib/api';

// ─── Tab Config ─────────────────────────────────────────
type TopTab = 'pipelines' | 'plugins' | 'dora';

const TOP_TABS: { id: TopTab; label: string; icon: typeof GitBranch }[] = [
  { id: 'pipelines', label: 'Pipelines', icon: GitBranch },
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
  { id: 'dora', label: 'DORA', icon: Gauge },
];

// Quick date-range presets. Each maps to a rolling window ending today; the
// bounds are computed client-side as `YYYY-MM-DD` (the format the native date
// inputs / backend from|to expect). A preset wider than the active tab's cap is
// clamped (with an inline note) rather than issuing an over-range request.
const DATE_PRESETS: { label: string; days: number }[] = [
  { label: 'Last 7d', days: 7 },
  { label: 'Last 30d', days: 30 },
  { label: 'Last 90d', days: 90 },
  { label: 'Last 180d', days: 180 },
  { label: 'Last 365d', days: 365 },
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

/** Parse a `YYYY-MM-DD` string as LOCAL midnight (matches {@link isoDay}), so
 *  clamp arithmetic doesn't drift by a day against the native date inputs. */
function parseDay(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

/** Whole days between a `YYYY-MM-DD` bound and an anchor date (anchor − from). */
function spanDays(from: string, anchor: Date): number {
  return Math.round((anchor.getTime() - parseDay(from).getTime()) / 86_400_000);
}

/**
 * Clamp a requested `from` to the tab's effective cap so the frontend never
 * issues an over-range request. Returns the (possibly narrowed) `from` and
 * whether it was clamped. An empty `from` is left as-is (the backend applies its
 * default window, which is within retention).
 */
function clampFrom(from: string, to: string, maxDays: number): { from: string; clamped: boolean } {
  if (!from) return { from: '', clamped: false };
  const anchor = to ? parseDay(to) : new Date();
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(parseDay(from).getTime())) return { from, clamped: false };
  if (spanDays(from, anchor) > maxDays) {
    const c = new Date(anchor);
    c.setDate(c.getDate() - maxDays);
    return { from: isoDay(c), clamped: true };
  }
  return { from, clamped: false };
}

/** Extract the backend range-cap (N days) from its "exceeds maximum of N days" error. */
function rangeCapFromError(error: string | null): number | null {
  if (!error) return null;
  const m = /exceeds maximum of (\d+) days/i.exec(error);
  return m ? Number(m[1]) : null;
}

// ─── Page ───────────────────────────────────────────────
export default function ReportsPage() {
  const { user, isReady, isAuthenticated, can } = useAuthGuard({ requirePermission: 'reports:read' });
  const router = useRouter();
  // DORA / advanced delivery analytics is a paid-tier entitlement. Gates the tab
  // body (non-entitled → upsell teaser) and the fetches (skip to avoid a 403).
  const doraEnabled = useFeatures().isEnabled('advanced_reporting');

  const [topTab, setTopTab] = useState<TopTab>('pipelines');

  // Honor ?tab=plugins|pipelines|dora on load and on browser back/forward.
  useEffect(() => {
    if (!router.isReady) return;
    const raw = router.query.tab;
    const tab = Array.isArray(raw) ? raw[0] : raw;
    if (tab === 'plugins' || tab === 'pipelines' || tab === 'dora') {
      setTopTab((prev) => (prev === tab ? prev : tab));
    }
  }, [router.isReady, router.query.tab]);

  // Switch the top-level tab and reflect it in the URL (shallow — the active tab
  // component keys its own fetch off its filters, so no route-driven refetch).
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
  // Org → team rollup: only admins/owners can aggregate child-team analytics, and
  // the toggle only appears when the org actually parents teams.
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [hasTeams, setHasTeams] = useState(false);
  const canRollup = can('reports:rollup');

  // Per-tab effective date-range caps (event vs DORA retention), read once.
  const retention = useReportRetention();
  // A per-tab cap the backend told us about (via a range error) that is TIGHTER
  // than the client's retention estimate — used as the safety-net clamp.
  const [serverCap, setServerCap] = useState<Partial<Record<TopTab, number>>>({});

  // Loading / error / refetch reported up by the active tab (drives the shared
  // banner + the refresh control). Only the mounted tab reports.
  const [status, setStatus] = useState<TabDataStatus>({ loading: true, error: null, refetch: () => {} });
  const onStatus = useCallback((s: TabDataStatus) => setStatus(s), []);

  // Effective max for the active tab: retention estimate, floored by any tighter
  // cap the backend reported.
  const baseMax = topTab === 'dora' ? retention.doraMax : retention.eventMax;
  const effectiveMax = serverCap[topTab] != null ? Math.min(baseMax, serverCap[topTab] as number) : baseMax;

  // Clamp the requested range to the tab cap so no over-range request is issued.
  const { from: clampedFrom, clamped } = clampFrom(dateFrom, dateTo, effectiveMax);

  // Safety net: if a range error still comes back (retention estimate was too
  // generous), record the backend's tighter cap → re-clamp → the active tab
  // refetches within bounds. Guarded so it applies once (no loop).
  useEffect(() => {
    const cap = rangeCapFromError(status.error);
    if (cap != null && serverCap[topTab] !== cap) {
      setServerCap((prev) => ({ ...prev, [topTab]: cap }));
    }
  }, [status.error, topTab, serverCap]);

  // A range error is handled by the clamp note, not the red banner (no dead-end).
  const isRangeError = rangeCapFromError(status.error) != null;

  const filters: SharedFilters = useMemo(
    () => ({ dateFrom: clampedFrom, dateTo, interval: timeInterval, includeDescendants }),
    [clampedFrom, dateTo, timeInterval, includeDescendants],
  );

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

  const tabNoun = topTab === 'dora' ? 'DORA' : topTab === 'plugins' ? 'plugin' : 'pipeline';

  return (
    <DashboardLayout
      title="Reports"
      subtitle="Pipeline execution analytics and plugin build insights"
      maxWidth="7xl"
      actions={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 justify-end">
          {canRollup && hasTeams && (topTab === 'pipelines' || topTab === 'dora') && (
            <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300" title="Aggregate pipeline analytics across this organization and its teams">
              <Checkbox
                checked={includeDescendants}
                onChange={(e) => setIncludeDescendants(e.target.checked)}
              />
              Include child teams
            </label>
          )}
          {/* Presets — set the same dateFrom/dateTo the manual picker drives. A
              preset wider than the tab cap still clamps (with the note below). */}
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
          <FilterSelect value={timeInterval} onChange={(e) => setTimeInterval(e.target.value as 'day' | 'week' | 'month')} aria-label="Report time interval">
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </FilterSelect>
          <AutoRefresh onRefresh={status.refetch} loading={status.loading} />
        </div>
      }
    >
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="page-section space-y-6">

        {/* ═══════ Top-level tabs: Pipelines / Plugins / DORA ═══════ */}
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

        {/* Subtle clamp note — the requested window was narrowed to the tab's
            retention cap (a quiet inline note, NOT a red dead-end error). */}
        {(clamped || isRangeError) && (
          <p className="text-xs text-gray-500 dark:text-gray-400" role="status">
            Showing the last {effectiveMax} days — the maximum for {tabNoun} reports.
          </p>
        )}

        {/* Inline error + retry — a failed fetch would otherwise look like empty
            data. Range errors are handled by the clamp note above, not here. */}
        {status.error && !status.loading && !isRangeError && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-sm text-red-700 dark:text-red-300">
            <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" />{status.error}</span>
            <button onClick={status.refetch} className="underline hover:no-underline shrink-0">Retry</button>
          </div>
        )}

        {topTab === 'pipelines' && <PipelinesTab filters={filters} onStatus={onStatus} />}
        {topTab === 'plugins' && <PluginsTab filters={filters} onStatus={onStatus} />}
        {topTab === 'dora' && (
          <DoraTab filters={filters} enabled={doraEnabled} canMark={can('reports:read')} onStatus={onStatus} />
        )}

      </motion.div>
    </DashboardLayout>
  );
}
