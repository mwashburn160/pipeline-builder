import { useEffect, useState, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { GitBranch, Puzzle, Gauge, Trophy } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useUrlTab } from '@/hooks/useUrlTab';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Checkbox } from '@/components/ui/Checkbox';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { RetryError } from '@/components/ui/RetryError';
import { DateRangePicker, AutoRefresh, TwoColumnSkeleton } from '@/components/reports/ReportHelpers';
import { IngestFreshness } from '@/components/reports/IngestFreshness';
import {
  useReportRetention, useIngestHealth, type SharedFilters, type TabDataStatus,
} from '@/components/reports/useReportData';
import { hasPermission } from '@/lib/auth-helpers';

// Only one top tab shows at a time, so each is its own chunk: the page ships the
// shell + the active tab instead of all four report bundles up front.
const tabLoading = () => <TwoColumnSkeleton />;
const PipelinesTab = dynamic(() => import('@/components/reports/tabs/PipelinesTab').then((m) => m.PipelinesTab), { loading: tabLoading });
const PluginsTab = dynamic(() => import('@/components/reports/tabs/PluginsTab').then((m) => m.PluginsTab), { loading: tabLoading });
const DoraTab = dynamic(() => import('@/components/reports/tabs/DoraTab').then((m) => m.DoraTab), { loading: tabLoading });
const ScorecardTab = dynamic(() => import('@/components/reports/tabs/ScorecardTab').then((m) => m.ScorecardTab), { loading: tabLoading });

/**
 * Billing add-on that widens each window: the Retention Pack (every tier)
 * raises standard-event retention; the DORA-History pack raises DORA's.
 */
const EXTEND_EVENT_RETENTION_HREF = '/dashboard/billing?highlight=retention_pack';
const EXTEND_DORA_RETENTION_HREF = '/dashboard/billing?highlight=dora_history_pack';

/** The absolute report ceiling — past it no pack helps, so no "extend" link. */
const MAX_REPORT_RANGE_DAYS = 730;

// ─── Tab Config ─────────────────────────────────────────
type TopTab = 'pipelines' | 'plugins' | 'dora' | 'scorecard';

const TOP_TABS: { id: TopTab; label: string; icon: typeof GitBranch }[] = [
  { id: 'pipelines', label: 'Pipelines', icon: GitBranch },
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
  { id: 'dora', label: 'DORA', icon: Gauge },
  { id: 'scorecard', label: 'Scorecard', icon: Trophy },
];
const TOP_TAB_IDS: readonly TopTab[] = TOP_TABS.map((t) => t.id);

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
  // Read gate (`reports:read`) comes from the nav entry via page-access.
  const { accessDenied, user, isReady, can, isReadOnly, isSuperAdmin } = useAuthGuard();
  // DORA / advanced delivery analytics is a paid-tier entitlement. Gates the tab
  // body (non-entitled → upsell teaser) and the fetches (skip to avoid a 403).
  // The shared gate folds in the superadmin bypass and the loaded state.
  const doraGate = useFeatureGate('advanced_reporting');
  const doraEnabled = doraGate.entitled;

  // `?tab=` on load and on browser back/forward; shallow URL write-back (the
  // active tab component keys its own fetch off its filters).
  const [topTab, selectTopTab] = useUrlTab<TopTab>('tab', TOP_TAB_IDS, 'pipelines');

  const changeTopTab = useCallback((id: TopTab) => {
    // Clear the outgoing tab's status so the range-cap effect below can't record
    // one tab's over-range error against the newly-selected tab (cross-tab cap
    // leak). The incoming tab re-reports via onStatus on mount. `setStatus` is a
    // stable useState setter, resolved at call time.
    setStatus({ loading: true, error: null, refetch: () => {} });
    selectTopTab(id);
  }, [selectTopTab]);

  const [timeInterval, setTimeInterval] = useState<'day' | 'week' | 'month'>('week');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // Org → team rollup: only admins/owners can aggregate child-team analytics, and
  // the toggle only appears when the org actually parents teams.
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const canRollup = can('reports:rollup');
  // The Scorecard roll-up reads GET /pipelines[/:id]/scorecard, which the pipeline
  // service gates on `pipelines:read` — a custom role with `reports:read` but no
  // pipeline read would be offered a tab that can only 403. Hide that one tab
  // (the permission is not purchasable, so there is nothing to upsell).
  const canReadPipelines = can('pipelines:read');
  const visibleTopTabs = TOP_TABS.filter((t) => t.id !== 'scorecard' || canReadPipelines);

  // Per-tab effective date-range caps (event vs DORA retention), read once from
  // the reports:read-only retention endpoint (so a Retention Pack shows without
  // Advanced Reporting).
  const retention = useReportRetention();
  // Ingestion freshness for the event-driven tabs — range-independent, so it is
  // read once (and on manual refresh) rather than per filter change.
  const ingest = useIngestHealth();
  // A per-tab cap the backend told us about (via a range error) that is TIGHTER
  // than the client's retention estimate — used as the safety-net clamp.
  const [serverCap, setServerCap] = useState<Partial<Record<TopTab, number>>>({});

  // Loading / error / refetch reported up by the active tab (drives the shared
  // banner + the refresh control). Only the mounted tab reports.
  const [status, setStatus] = useState<TabDataStatus>({ loading: true, error: null, refetch: () => {} });
  const onStatus = useCallback((s: TabDataStatus) => setStatus(s), []);

  // Effective max for the active tab: retention estimate, floored by any tighter
  // cap the backend reported.
  const baseMax = topTab === 'dora' ? retention.doraMaxRangeDays : retention.eventMaxRangeDays;
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

  // Is the active cap the org's retention (buyable) rather than the fixed
  // ceiling or a tighter server cap? Only then is "Extend retention" useful.
  const horizonDays = topTab === 'dora' ? retention.doraRetentionDays : retention.eventRetentionDays;
  const capIsRetention = horizonDays !== -1 && horizonDays < MAX_REPORT_RANGE_DAYS && effectiveMax === baseMax;
  const extendHref = capIsRetention
    ? (topTab === 'dora' ? EXTEND_DORA_RETENTION_HREF : EXTEND_EVENT_RETENTION_HREF)
    : undefined;

  // ONE scope for every panel: the rollup switch is threaded through every
  // rollup-aware report on every tab, not just some of them.
  const filters: SharedFilters = useMemo(
    () => ({ dateFrom: clampedFrom, dateTo, interval: timeInterval, includeDescendants, systemAdmin: isSuperAdmin }),
    [clampedFrom, dateTo, timeInterval, includeDescendants, isSuperAdmin],
  );

  // The rollup toggle only shows when the active org parents teams — there's
  // nothing to roll up otherwise.
  const { hasChildOrgs: hasTeams } = useOrgHierarchy();

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  const tabNoun = topTab === 'dora' ? 'DORA' : topTab === 'plugins' ? 'plugin' : 'pipeline';

  return (
    <DashboardLayout
      title="Reports"
      subtitle="Pipeline execution analytics and plugin build insights"
      maxWidth="7xl"
      actions={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 justify-end">
          {canRollup && hasTeams && topTab !== 'scorecard' && (
            <label className="inline-flex items-center gap-2 text-sm text-fg" title="Aggregate analytics across this organization and its teams">
              <Checkbox
                checked={includeDescendants}
                onChange={(e) => setIncludeDescendants(e.target.checked)}
              />
              Include child teams
            </label>
          )}
          {/* Date-range controls drive dateFrom/dateTo/interval, which the
              Scorecard tab ignores (its roll-up is a fixed server-side 30-day
              window) — so hide them there rather than render inert controls. */}
          {topTab !== 'scorecard' && (
          <>
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
                      ? 'bg-brand text-white'
                      : 'text-fg-muted hover:bg-surface-muted'
                  }`}
                  title={`Show the last ${p.days} days`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <DateRangePicker
            from={dateFrom}
            to={dateTo}
            onFromChange={setDateFrom}
            onToChange={setDateTo}
            maxRangeDays={effectiveMax}
            extendHref={extendHref}
          />
          <FilterSelect value={timeInterval} onChange={(e) => setTimeInterval(e.target.value as 'day' | 'week' | 'month')} aria-label="Report time interval">
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </FilterSelect>
          </>
          )}
          {/* Refresh the active tab AND the freshness read — otherwise the strip
              keeps asserting the state it saw on mount. */}
          <AutoRefresh onRefresh={() => { status.refetch(); ingest.reload(); }} loading={status.loading} />
        </div>
      }
    >
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="page-section space-y-6">

        {/* ═══════ Top-level tabs: Pipelines / Plugins / DORA ═══════ */}
        <div className="flex gap-2">
          {visibleTopTabs.map((tab) => {
            const Icon = tab.icon;
            const active = topTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => changeTopTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-info-bg text-info ring-1 ring-info-border'
                    : 'text-fg-muted hover:bg-surface-muted'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Ingestion freshness — only on the tabs computed from ingested pipeline
            events (Pipelines / DORA). Plugin build reports and the Scorecard roll-up
            don't come through the event forwarder, so the strip would say nothing
            about their data. It's what separates "nothing shipped this week" from
            "we haven't heard from the ingest pipeline since Tuesday". */}
        {(topTab === 'pipelines' || topTab === 'dora') && (
          <IngestFreshness data={ingest.data} loading={ingest.loading} error={ingest.error} />
        )}

        {/* Subtle clamp note — the requested window was narrowed to the tab's
            retention cap (a quiet inline note, NOT a red dead-end error). */}
        {topTab !== 'scorecard' && (clamped || isRangeError) && (
          <p className="text-xs text-fg-muted" role="status">
            Showing the last {effectiveMax} days — the maximum for {tabNoun} reports.
            {extendHref && (
              <>{' '}<Link href={extendHref} className="action-link">Extend retention</Link></>
            )}
          </p>
        )}

        {/* Inline error + retry — a failed fetch would otherwise look like empty
            data. Range errors are handled by the clamp note above, not here. */}
        {status.error && !status.loading && !isRangeError && (
          <RetryError message={status.error} onRetry={status.refetch} />
        )}

        {topTab === 'pipelines' && <PipelinesTab filters={filters} onStatus={onStatus} />}
        {topTab === 'plugins' && <PluginsTab filters={filters} onStatus={onStatus} />}
        {/* The entitled tabs wait for the entitlement verdict, so an entitled org
            never sees a flash of the upsell. */}
        {(topTab === 'dora' || topTab === 'scorecard') && !doraGate.isLoaded && <TwoColumnSkeleton />}
        {topTab === 'dora' && doraGate.isLoaded && (
          // Marking an outcome is a write gated on `pipelines:write`. Checked with
          // `hasPermission` (not `can()`, which folds in read-only impersonation) so
          // a read-only session still SEES the controls, disabled with the reason.
          <DoraTab filters={filters} enabled={doraEnabled} canMark={hasPermission(user, 'pipelines:write')} markReadOnly={isReadOnly} onStatus={onStatus} />
        )}
        {topTab === 'scorecard' && canReadPipelines && doraGate.isLoaded && (
          <ScorecardTab enabled={doraEnabled} onStatus={onStatus} />
        )}

      </motion.div>
    </DashboardLayout>
  );
}
