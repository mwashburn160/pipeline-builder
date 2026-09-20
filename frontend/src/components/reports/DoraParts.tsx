// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DORA-specific report UI: the metric cards, the trend sparkline, the
 * non-entitled upsell teaser, and the scope (pipeline / environment / window)
 * controls.
 *
 * Split out of `ReportHelpers.tsx`, which had grown to hold five unrelated
 * concerns behind one import. Only the DORA block moved: the small shared
 * pieces (`ReportEmpty`, `SectionHeading`, the skeletons, `ExportCSVButton`)
 * stayed put because twelve report components already import them TOGETHER —
 * splitting those too would have given most of those files three or four import
 * lines in place of one, trading a tidy module for messier call sites.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { Tooltip } from '@/components/ui/Tooltip';
import { FEATURE_METADATA } from '@/lib/feature-flags';
import type { DoraLevel, DoraTrendPoint } from '@/lib/api/domains/reporting';
import { StatCard } from './StatCard';
// Small shared report pieces stay in ReportHelpers — see the module note.
import { SectionHeading, fmtDate } from './ReportHelpers';
import { CFR_ELEVATED_PCT, SPARKLINE_MIN_BAR_PCT, SPARKLINE_ZERO_BAR_PCT } from './constants';

/** Format a DORA reporting window as e.g. "Jun 27 – Jul 27, 2026". Invalid dates → "". */
/**
 * Scorecard letter-grade → badge palette (shared by ScorecardCard and the
 * org-wide ScorecardTab so the grade colors can't drift between the two views).
 */
export const GRADE_STYLES: Record<string, string> = {
  A: 'bg-success-bg text-success-strong',
  B: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
  C: 'bg-warning-bg text-warning-strong',
  D: 'bg-warning-bg text-warning-strong',
  F: 'bg-danger-bg text-danger-strong',
  'N/A': 'bg-surface-muted text-fg-muted',
};

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
      return { label: 'Elite', className: 'bg-success-bg text-success' };
    case 'high':
      return { label: 'High', className: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' };
    case 'medium':
      return { label: 'Medium', className: 'bg-warning-bg text-warning' };
    case 'low':
      return { label: 'Low', className: 'bg-danger-bg text-danger' };
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
/** Shared level-badge pill for a DORA metric. Returns null for an unrated level. */
function DoraLevelBadge({ level }: { level: DoraLevel }) {
  const badge = doraLevelBadge(level);
  if (!badge) return null;
  return (
    <span className={`shrink-0 px-1.5 py-0.5 rounded text-2xs font-medium leading-none ${badge.className}`}>
      {badge.label}
    </span>
  );
}

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
      className={tooltip ? 'focus:outline-none focus:ring-2 focus:ring-brand/50 rounded-lg' : ''}
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
  // Per-bucket change-failure rate, derived from failed/total (the backend trend
  // now carries counts only, not a precomputed pct).
  const cfrPct = (p: DoraTrendPoint) => (p.total > 0 ? Math.round((p.failed / p.total) * 100) : 0);
  // Summary conveyed to assistive tech so the chart isn't an opaque "image":
  // total deploys + the deploy-weighted average change-failure rate over the
  // window, plus how many buckets sat in the elevated (>=30% CFR) band.
  const totalDeploys = points.reduce((s, p) => s + p.deployments, 0);
  const totalFailed = points.reduce((s, p) => s + p.failed, 0);
  const totalConsidered = points.reduce((s, p) => s + p.total, 0);
  const avgCfr = totalConsidered > 0 ? Math.round((totalFailed / totalConsidered) * 100) : 0;
  const hotCount = points.filter((p) => cfrPct(p) >= CFR_ELEVATED_PCT).length;
  const summary =
    `Deployment trend over ${points.length} period${points.length === 1 ? '' : 's'}: ` +
    `${totalDeploys} total deployment${totalDeploys === 1 ? '' : 's'}, ` +
    `average change-failure rate ${avgCfr}%` +
    (hotCount > 0 ? `, ${hotCount} period${hotCount === 1 ? '' : 's'} with elevated change-failure (${CFR_ELEVATED_PCT}%+).` : '.');
  return (
    <Card>
      <SectionHeading>Deployment Trend</SectionHeading>
      <div className="flex items-end gap-1 h-16" role="img" aria-label={summary}>
        {points.map((p) => {
          const h = Math.max((p.deployments / max) * 100, p.deployments > 0 ? SPARKLINE_MIN_BAR_PCT : SPARKLINE_ZERO_BAR_PCT);
          const hot = cfrPct(p) >= CFR_ELEVATED_PCT;
          return (
            <div
              key={p.period}
              className="flex-1 flex flex-col justify-end"
              title={`${fmtDate(p.period)}: ${p.deployments} deploy${p.deployments === 1 ? '' : 's'} · ${cfrPct(p)}% CFR`}
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
              <td>{cfrPct(p)}%</td>
              <td>{cfrPct(p) >= CFR_ELEVATED_PCT ? 'Elevated change-failure' : 'Normal'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between mt-1.5 text-xs text-fg-subtle tabular-nums">
        <span>{fmtDate(points[0].period)}</span>
        <span>Deploys / period &middot; red = elevated change-failure</span>
        <span>{fmtDate(points[points.length - 1].period)}</span>
      </div>
    </Card>
  );
}

// ─── DORA Upsell (non-entitled teaser) ──────────────────

/** Sample values for the blurred DORA teaser shown to non-entitled users. */
const SAMPLE_DORA_CARDS: { label: string; value: string; sub: string; level: DoraLevel }[] = [
  { label: 'Deployment Frequency', value: '8', sub: 'deploys · 0.27/day', level: 'high' },
  { label: 'Lead time', value: '5m 30s', sub: 'median commit→deploy · 8 measured', level: 'elite' },
  { label: 'Change Failure Rate', value: '25%', sub: '2/8 deploys failed', level: 'medium' },
  { label: 'Time to Restore (MTTR)', value: '1h 2m', sub: '2/2 incidents restored', level: 'high' },
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
      <div className="relative overflow-hidden rounded-lg border border-default">
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
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/70 backdrop-blur-[1px] px-6 py-8 text-center">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-info-bg text-brand">
            <Lock className="w-5 h-5" aria-hidden="true" />
          </span>
          <h4 className="text-base font-semibold text-fg">{meta.label} &mdash; DORA metrics</h4>
          <p className="max-w-md text-sm text-fg-muted">
            Track deployment frequency, change failure rate, mean time to restore (MTTR) and measured lead time,
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
const DEFAULT_ENVIRONMENTS = ['production', 'staging', 'development', 'preview', 'qa'];

interface DoraScopeControlsProps {
  /** Pipelines to offer in the picker (from the overview execution list). */
  pipelines: { id: string; name: string }[];
  /** Environments actually observed in the window; merged with the defaults for the datalist. */
  environmentOptions: string[];
  pipelineId: string;
  environment: string;
  onPipelineChange: (v: string) => void;
  /** Live value change (keystroke) — updates the controlled input only. */
  onEnvironmentChange: (v: string) => void;
  /** Commit the environment value to the fetch (fires on blur / Enter). */
  onEnvironmentCommit: (v: string) => void;
}

/**
 * The DORA scope value + callbacks a parent forwards to {@link DoraScopeControls}
 * (everything except the derived `pipelines`/`environmentOptions` lists). Bundled
 * so callers pass one `doraScope` bag instead of ~7 individual props.
 */
export type DoraScope = Omit<DoraScopeControlsProps, 'pipelines' | 'environmentOptions'>;

/**
 * Scoping controls for the DORA section: pipeline picker + an optional
 * environment filter. Wires the backend `pipelineId`/`environment` params. DORA
 * is always deploy-basis (there is no run-basis fallback), so there is no
 * deployments-only toggle. Styled to match the page's other filter controls
 * (DateRangePicker / interval select).
 */
export function DoraScopeControls({
  pipelines, environmentOptions, pipelineId, environment,
  onPipelineChange, onEnvironmentChange, onEnvironmentCommit,
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
      <FilterSelect
        id="dora-pipeline"
        value={pipelineId}
        onChange={(e) => onPipelineChange(e.target.value)}
        className="text-xs"
        title="Scope DORA metrics to a single pipeline"
      >
        <option value="">All pipelines</option>
        {pipelines.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </FilterSelect>
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
    </div>
  );
}
