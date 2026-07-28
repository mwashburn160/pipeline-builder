import { useState, useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { RefreshCw, Download, Timer, Lock } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { FEATURE_METADATA } from '@/lib/feature-flags';
import type { DoraLevel, DoraTrendPoint } from '@/lib/api/domains/reporting';
import { StatCard } from './StatCard';
import { CFR_ELEVATED_PCT, SPARKLINE_MIN_BAR_PCT, SPARKLINE_ZERO_BAR_PCT } from './constants';

/** Shared level-badge pill for a DORA metric. Returns null for an unrated level. */
function DoraLevelBadge({ level }: { level: DoraLevel }) {
  const badge = doraLevelBadge(level);
  if (!badge) return null;
  return (
    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium leading-none ${badge.className}`}>
      {badge.label}
    </span>
  );
}

// ─── Formatting ─────────────────────────────────────────

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/** Humanize a duration in seconds → "45s", "5m", "1h 2m", "2d 3h". Null → "—". */
export function fmtSeconds(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Shared Components ──────────────────────────────────

export function ReportEmpty({ text }: { text: string }) {
  return <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">{text}</p>;
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="section-title text-sm tracking-tight mb-3">{children}</h3>;
}

interface StackedTimelineBarProps {
  /** ISO period label rendered on the left (formatted via {@link fmtDate}). */
  period: string;
  succeeded: number;
  failed: number;
  /** Optional third (yellow) segment. Omit for a two-segment pass/fail bar. */
  canceled?: number;
}

/**
 * One period row of the stacked pass/fail(/cancel) timeline: a date label, a
 * flex track split into green/red[/yellow] segments proportional to the counts,
 * and the period total. Shared by the pipeline Execution Timeline and the plugin
 * Build Success Rate visuals (identical markup; canceled is pipeline-only).
 */
export function StackedTimelineBar({ period, succeeded, failed, canceled }: StackedTimelineBarProps) {
  const total = succeeded + failed + (canceled ?? 0);
  const sPct = total > 0 ? (succeeded / total) * 100 : 0;
  const fPct = total > 0 ? (failed / total) * 100 : 0;
  const cPct = total > 0 ? ((canceled ?? 0) / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-400 dark:text-gray-500 w-16 shrink-0 tabular-nums">{fmtDate(period)}</span>
      <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden flex">
        {sPct > 0 && <div className="h-full bg-green-500" style={{ width: `${sPct}%` }} />}
        {fPct > 0 && <div className="h-full bg-red-500" style={{ width: `${fPct}%` }} />}
        {cPct > 0 && <div className="h-full bg-yellow-400" style={{ width: `${cPct}%` }} />}
      </div>
      <span className="text-xs text-gray-400 dark:text-gray-500 w-12 text-right tabular-nums">{total}</span>
    </div>
  );
}

// ─── DORA ───────────────────────────────────────────────

/** Format a DORA reporting window as e.g. "Jun 27 – Jul 27, 2026". Invalid dates → "". */
export function fmtWindow(window?: { from: string; to: string }): string {
  if (!window) return '';
  const from = new Date(window.from);
  const to = new Date(window.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return '';
  const fromStr = from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const toStr = to.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fromStr} – ${toStr}`;
}

/**
 * Map a DORA performance band to a display label + Tailwind pill classes
 * (dark-mode aware). Returns null for an unrated (null) level so callers can
 * render nothing.
 */
export function doraLevelBadge(level: DoraLevel): { label: string; className: string } | null {
  switch (level) {
    case 'elite':
      return { label: 'Elite', className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' };
    case 'high':
      return { label: 'High', className: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' };
    case 'medium':
      return { label: 'Medium', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' };
    case 'low':
      return { label: 'Low', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' };
    default:
      return null;
  }
}

interface DoraCardProps {
  label: ReactNode;
  value: string;
  sub: ReactNode;
  level?: DoraLevel;
  /** Optional a11y tooltip (keyboard/SR-visible via the shared Tooltip). */
  tooltip?: string;
}

/** A single DORA metric card with an optional performance-level badge + tooltip. */
export function DoraCard({ label, value, sub, level = null, tooltip }: DoraCardProps) {
  // When a tooltip is present the card becomes a focusable group so keyboard
  // and screen-reader users reach the caveat: `tabIndex` lets the shared
  // Tooltip's onFocus fire and `role="group"` marks the region. The caveat text
  // is announced solely via the Tooltip's `aria-describedby` — NOT duplicated as
  // an `aria-label` here (that would double-announce the same sentence). A single
  // tooltip mechanism only — no native `title`, which would otherwise double up
  // with the custom bubble on hover.
  const card = (
    <StatCard
      variant="detailed"
      label={label}
      value={value}
      sub={sub}
      badge={<DoraLevelBadge level={level} />}
      className={tooltip ? 'focus:outline-none focus:ring-2 focus:ring-blue-500/50 rounded-lg' : ''}
      wrapperProps={tooltip ? { tabIndex: 0, role: 'group' } : undefined}
    />
  );

  if (!tooltip) return card;
  // `multiline` lets the sentence-length caveat wrap + cap width (the default
  // bubble is `whitespace-nowrap` and would overflow the viewport). `w-full`
  // keeps the wrapped card the same width as the un-wrapped grid cells.
  return (
    <Tooltip content={tooltip} multiline className="w-full">
      {card}
    </Tooltip>
  );
}

/**
 * Compact deployment-frequency sparkline (mini bar chart) for the DORA trend.
 * Inline SVG-free div bars matching the page's other timeline visuals — bar
 * height encodes deployments per bucket; hue reddens with change-failure %.
 */
export function DoraTrendSparkline({ points }: { points: DoraTrendPoint[] }) {
  if (points.length === 0) return null;
  const max = Math.max(1, ...points.map((p) => p.deployments));
  // Summary conveyed to assistive tech so the chart isn't an opaque "image":
  // total deploys + the deploy-weighted average change-failure rate over the
  // window, plus how many buckets sat in the elevated (>=30% CFR) band.
  const totalDeploys = points.reduce((s, p) => s + p.deployments, 0);
  const totalFailed = points.reduce((s, p) => s + p.failed, 0);
  const totalConsidered = points.reduce((s, p) => s + p.total, 0);
  const avgCfr = totalConsidered > 0 ? Math.round((totalFailed / totalConsidered) * 100) : 0;
  const hotCount = points.filter((p) => p.changeFailurePct >= CFR_ELEVATED_PCT).length;
  const summary =
    `Deployment trend over ${points.length} period${points.length === 1 ? '' : 's'}: ` +
    `${totalDeploys} total deployment${totalDeploys === 1 ? '' : 's'}, ` +
    `average change-failure rate ${avgCfr}%` +
    (hotCount > 0 ? `, ${hotCount} period${hotCount === 1 ? '' : 's'} with elevated change-failure (${CFR_ELEVATED_PCT}%+).` : '.');
  return (
    <div className="card">
      <SectionHeading>Deployment Trend</SectionHeading>
      <div className="flex items-end gap-1 h-16" role="img" aria-label={summary}>
        {points.map((p) => {
          const h = Math.max((p.deployments / max) * 100, p.deployments > 0 ? SPARKLINE_MIN_BAR_PCT : SPARKLINE_ZERO_BAR_PCT);
          const hot = p.changeFailurePct >= CFR_ELEVATED_PCT;
          return (
            <div
              key={p.period}
              className="flex-1 flex flex-col justify-end"
              title={`${fmtDate(p.period)}: ${p.deployments} deploy${p.deployments === 1 ? '' : 's'} · ${p.changeFailurePct}% CFR`}
            >
              <div
                className={`w-full rounded-sm ${hot ? 'bg-red-500/70 dark:bg-red-400/70' : 'bg-blue-500/70 dark:bg-blue-400/70'}`}
                style={{ height: `${h}%` }}
              />
            </div>
          );
        })}
      </div>
      {/* Visually-hidden per-period data table — the bars encode values only in
          `title=`/height (not exposed to SR), so mirror them as real, readable
          data. Elevated-failure state is carried as a text tag, not color alone. */}
      <table className="sr-only">
        <caption>Deployments and change-failure rate per period</caption>
        <thead>
          <tr><th scope="col">Period</th><th scope="col">Deployments</th><th scope="col">Change-failure rate</th><th scope="col">Status</th></tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.period}>
              <td>{fmtDate(p.period)}</td>
              <td>{p.deployments}</td>
              <td>{p.changeFailurePct}%</td>
              <td>{p.changeFailurePct >= CFR_ELEVATED_PCT ? 'Elevated change-failure' : 'Normal'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between mt-1.5 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
        <span>{fmtDate(points[0].period)}</span>
        <span>Deploys / period &middot; red = elevated change-failure</span>
        <span>{fmtDate(points[points.length - 1].period)}</span>
      </div>
    </div>
  );
}

// ─── DORA Upsell (non-entitled teaser) ──────────────────

/** Sample values for the blurred DORA teaser shown to non-entitled users. */
const SAMPLE_DORA_CARDS: { label: string; value: string; sub: string; level: DoraLevel }[] = [
  { label: 'Deployment Frequency', value: '8', sub: 'deploys · 0.27/day', level: 'high' },
  { label: 'Change Failure Rate', value: '25%', sub: '2/8 deploys failed', level: 'medium' },
  { label: 'Time to Restore (MTTR)', value: '1h 2m', sub: '2/2 incidents restored', level: 'high' },
  { label: 'Lead time ≈', value: '5m 30s', sub: 'Approx · median run time', level: 'elite' },
];

/**
 * Locked teaser rendered in place of the DORA section when the viewer lacks the
 * `advanced_reporting` entitlement. Shows a blurred sample of the four DORA
 * cards behind a lock + CTA that deep-links to the add-on on the billing page.
 */
export function DoraUpsell() {
  const meta = FEATURE_METADATA.advanced_reporting;
  return (
    <div>
      <SectionHeading>DORA Metrics</SectionHeading>
      <div className="relative overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        {/* Blurred, inert sample behind the overlay — decorative only. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-4 blur-[3px] opacity-60 select-none pointer-events-none" aria-hidden="true">
          {SAMPLE_DORA_CARDS.map((c) => (
            <StatCard
              key={c.label}
              variant="detailed"
              label={c.label}
              value={c.value}
              sub={c.sub}
              badge={<DoraLevelBadge level={c.level} />}
            />
          ))}
        </div>
        {/* Overlay: the real, accessible content + CTA. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/70 dark:bg-gray-900/70 backdrop-blur-[1px] px-6 py-8 text-center">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300">
            <Lock className="w-5 h-5" aria-hidden="true" />
          </span>
          <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100">{meta.label} &mdash; DORA metrics</h4>
          <p className="max-w-md text-sm text-gray-600 dark:text-gray-400">
            Track deployment frequency, change failure rate, mean time to restore (MTTR) and a lead-time proxy,
            each rated against elite/high/medium/low performance bands. {meta.description}.
          </p>
          <Link href="/dashboard/billing?highlight=advanced_reporting" className="btn btn-primary btn-sm mt-1">
            Unlock Advanced Reporting
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── DORA Scope Controls (entitled only) ────────────────

/**
 * Sensible default environment names offered in the datalist even before an org
 * has any deploy-attributed executions — so the combobox is useful on day one.
 * Merged with (and deduped against) the environments actually observed.
 */
export const DEFAULT_ENVIRONMENTS = ['production', 'staging', 'development', 'preview', 'qa'];

interface DoraScopeControlsProps {
  /** Pipelines to offer in the picker (from the overview execution list). */
  pipelines: { id: string; name: string }[];
  /** Environments actually observed in the window; merged with the defaults for the datalist. */
  environmentOptions: string[];
  pipelineId: string;
  environment: string;
  deploysOnly: boolean;
  onPipelineChange: (v: string) => void;
  /** Live value change (keystroke) — updates the controlled input only. */
  onEnvironmentChange: (v: string) => void;
  /** Commit the environment value to the fetch (fires on blur / Enter). */
  onEnvironmentCommit: (v: string) => void;
  onDeploysOnlyChange: (v: boolean) => void;
}

/**
 * The DORA scope value + callbacks a parent forwards to {@link DoraScopeControls}
 * (everything except the derived `pipelines`/`environmentOptions` lists). Bundled
 * so callers pass one `doraScope` bag instead of ~7 individual props.
 */
export type DoraScope = Omit<DoraScopeControlsProps, 'pipelines' | 'environmentOptions'>;

/**
 * Scoping controls for the DORA section: pipeline picker, a deployments-only
 * toggle, and an optional environment filter. Wires the backend
 * `pipelineId`/`deploysOnly`/`environment` params. Styled to match the page's
 * other filter controls (DateRangePicker / interval select).
 */
export function DoraScopeControls({
  pipelines, environmentOptions, pipelineId, environment, deploysOnly,
  onPipelineChange, onEnvironmentChange, onEnvironmentCommit, onDeploysOnlyChange,
}: DoraScopeControlsProps) {
  // Observed environments first (most relevant), then any defaults not already
  // present — deduped case-insensitively so "prod"/"Prod" don't both appear.
  const envSuggestions = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of [...environmentOptions, ...DEFAULT_ENVIRONMENTS]) {
      const key = e.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  })();
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <label className="sr-only" htmlFor="dora-pipeline">Filter DORA by pipeline</label>
      <select
        id="dora-pipeline"
        value={pipelineId}
        onChange={(e) => onPipelineChange(e.target.value)}
        className="filter-select text-xs"
        title="Scope DORA metrics to a single pipeline"
      >
        <option value="">All pipelines</option>
        {pipelines.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {/* Debounced/committed value: typing only updates the controlled input;
          the fetch is triggered on blur or Enter (plus a page-level debounce)
          so a per-keystroke request storm is avoided. */}
      <input
        type="text"
        list="dora-environments"
        value={environment}
        onChange={(e) => onEnvironmentChange(e.target.value)}
        onBlur={(e) => onEnvironmentCommit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnvironmentCommit((e.target as HTMLInputElement).value); }}
        placeholder="Environment (e.g. prod)"
        className="filter-select text-xs w-44"
        title="Scope DORA metrics to a deployment environment"
        aria-label="Filter DORA by environment"
      />
      <datalist id="dora-environments">
        {envSuggestions.map((e) => (
          <option key={e} value={e} />
        ))}
      </datalist>
      <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400" title="Count only steps marked as deployments (excludes non-deploy pipeline runs)">
        <input
          type="checkbox"
          checked={deploysOnly}
          onChange={(e) => onDeploysOnlyChange(e.target.checked)}
          className="rounded border-gray-300 dark:border-gray-600"
        />
        Deployments only
      </label>
    </div>
  );
}

/** Map of supported column counts to Tailwind grid classes (avoids dynamic class generation). */
const gridColsClass: Record<number, string> = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-5',
  6: 'sm:grid-cols-6',
};

/** Skeleton cards matching the summary stat card layout. */
export function StatCardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid grid-cols-2 ${gridColsClass[count] ?? 'sm:grid-cols-4'} gap-4`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card py-4 text-center">
          <Skeleton className="h-8 w-16 mx-auto mb-2" />
          <Skeleton className="h-3 w-20 mx-auto" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton matching a card with a section heading and content. */
export function SectionCardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="card">
      <Skeleton className="h-4 w-32 mb-4" />
      <div className="space-y-3">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-4 flex-1 rounded" />
            <Skeleton className="h-3 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Skeleton for a two-column card grid. */
export function TwoColumnSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <SectionCardSkeleton lines={5} />
      <SectionCardSkeleton lines={5} />
    </div>
  );
}

// ─── Date Range Picker ──────────────────────────────────

interface DateRangePickerProps {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}

export function DateRangePicker({ from, to, onFromChange, onToChange }: DateRangePickerProps) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        value={from}
        onChange={(e) => onFromChange(e.target.value)}
        className="filter-select text-xs tabular-nums"
        title="From date"
      />
      <span className="text-xs text-gray-400">→</span>
      <input
        type="date"
        value={to}
        onChange={(e) => onToChange(e.target.value)}
        className="filter-select text-xs tabular-nums"
        title="To date"
      />
    </div>
  );
}

// ─── Auto-Refresh Toggle ────────────────────────────────

const REFRESH_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '30s', value: 30_000 },
  { label: '1m', value: 60_000 },
  { label: '5m', value: 300_000 },
];

interface AutoRefreshProps {
  onRefresh: () => void;
  loading: boolean;
}

export function AutoRefresh({ onRefresh, loading }: AutoRefreshProps) {
  const [interval, setInterval_] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (interval > 0) {
      timerRef.current = setInterval(onRefresh, interval);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [interval, onRefresh]);

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1 border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
        {REFRESH_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setInterval_(opt.value)}
            className={`px-2 py-1 text-xs font-medium transition-colors ${
              interval === opt.value
                ? 'bg-blue-600 text-white'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {interval > 0 && (
        <Timer className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
      )}
      <button onClick={onRefresh} disabled={loading} className="btn btn-secondary px-3 py-1.5 text-sm">
        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
      </button>
    </div>
  );
}

// ─── CSV Export ──────────────────────────────────────────

interface ExportButtonProps {
  data: Record<string, unknown>[];
  filename: string;
}

// CSV formula-injection defense: Excel/LibreOffice treat leading `=`, `+`, `-`,
// `@`, tab, or CR as formula starters. If a user names a pipeline `=cmd|'/c calc'`
// and an operator opens the export in Excel, the formula executes. Prefix any
// such cell with a leading `'` so the spreadsheet renders it as literal text.
function escapeCsvCell(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function ExportCSVButton({ data, filename }: ExportButtonProps) {
  const handleExport = () => {
    if (data.length === 0) return;
    const headers = Object.keys(data[0]);
    const rows = data.map(row => headers.map(h => {
      const val = row[h];
      const raw = val === null || val === undefined ? '' : String(val);
      const str = escapeCsvCell(raw);
      return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      onClick={handleExport}
      disabled={data.length === 0}
      className="btn btn-ghost btn-xs"
      title="Export to CSV"
    >
      <Download className="w-3.5 h-3.5 mr-1" />
      CSV
    </button>
  );
}
