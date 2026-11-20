// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, type ReactNode } from 'react';
import { Lightbulb, Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import { FEATURE_METADATA } from '@/lib/feature-flags';
import { formatError } from '@/lib/constants';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type {
  AdoptionData, FailureAnalysisData, InsightDataById, InsightSection, InsightSectionId, InsightsResult,
  NeedsAttentionData, OutdatedPluginsData, PromotionData, ResourceConsumptionData,
} from '@/lib/api/domains/reporting-insights';
import { ExportCSVButton, ReportEmpty, SectionCardSkeleton, SectionHeading } from '../ReportHelpers';
import { useReportBucketing, type SharedFilters, type TabDataStatus } from '../useReportData';

interface InsightsTabProps {
  filters: SharedFilters;
  /** Whether `advanced_reporting` is entitled — non-entitled renders the upsell and fetches nothing. */
  enabled: boolean;
  /** Report loading/error/refetch up to the shell (shared banner + refresh). */
  onStatus: (status: TabDataStatus) => void;
}

/** Display order and the card titles used before the first response lands. */
const CARDS: ReadonlyArray<{ id: InsightSectionId; title: string; csv: string }> = [
  { id: 'needs_attention', title: 'Needs attention', csv: 'insights-needs-attention' },
  { id: 'failure_analysis', title: 'What is breaking', csv: 'insights-failure-analysis' },
  { id: 'promotion', title: 'What reached production, and what did not', csv: 'insights-promotion' },
  { id: 'resource_consumption', title: 'Where the build time went', csv: 'insights-resource-consumption' },
  { id: 'outdated_plugins', title: 'Plugins behind their latest version', csv: 'insights-outdated-plugins' },
  { id: 'adoption', title: 'Adoption and coverage', csv: 'insights-adoption' },
];

/** Build time as "3h 20m" / "45m" / "30s". Seconds, never money. */
export function fmtBuildTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const shortSha = (sha: string) => sha.slice(0, 8);
const pipelineLabel = (name: string | null, id: string) => name || id;

// ─── CSV rows, one flat table per card ─────────────────

/** The rows a card's CSV button exports. Pure, for the tests. */
export function insightCsvRows<K extends InsightSectionId>(id: K, data: InsightDataById[K] | undefined): Record<string, unknown>[] {
  if (!data) return [];
  switch (id) {
    case 'needs_attention':
      return (data as NeedsAttentionData).items.flatMap((i) => i.findings.map((f) => ({
        pipeline: pipelineLabel(i.pipelineName, i.pipelineId), pipeline_id: i.pipelineId, rule: f.rule, severity: f.severity, evidence: f.evidence,
      })));
    case 'failure_analysis':
      return (data as FailureAnalysisData).categories.map((c) => ({
        category: c.label, failures: c.count, share_pct: c.sharePct, team_actionable: c.teamActionable, change: c.change ?? '',
        top_pipelines: c.topPipelines.map((p) => `${pipelineLabel(p.pipelineName, p.pipelineId)} (${p.count})`).join('; '),
      }));
    case 'promotion':
      return (data as PromotionData).commits.map((c) => ({
        commit: c.commitSha, furthest: c.furthest, stuck: c.stuck,
        path: c.stops.map((s) => `${s.environment}@${s.deployedAt}`).join(' > '),
      }));
    case 'resource_consumption':
      return (data as ResourceConsumptionData).pipelines.map((p) => ({
        project: p.project ?? '', pipeline: pipelineLabel(p.pipelineName, p.pipelineId), build_seconds: p.buildSeconds, runs: p.runs, share_pct: p.sharePct,
      }));
    case 'outdated_plugins':
      return (data as OutdatedPluginsData).rows.map((r) => ({
        pipeline: pipelineLabel(r.pipelineName, r.pipelineId), stage: r.stageName, step: r.stepName, plugin: r.plugin,
        in_use: r.inUse ?? '', latest: r.latest ?? '', gap: r.gap ?? '', within_policy: r.withinPolicy,
      }));
    case 'adoption': {
      const a = data as AdoptionData;
      return [{
        total_pipelines: a.totalPipelines, active_pipelines: a.activePipelines, deploy_tracked_pipelines: a.deployTrackedPipelines,
        active_teams: a.activeTeams, estimated_minutes_saved: a.estimatedMinutesSaved ?? '',
        ...Object.fromEntries(Object.entries(a.bySource).map(([k, v]) => [`created_${k}`, v])),
      }];
    }
    default:
      return [];
  }
}

// ─── Card bodies ───────────────────────────────────────

function NeedsAttentionBody({ data }: { data: NeedsAttentionData }) {
  return (
    <>
      {data.unavailableRules && data.unavailableRules.length > 0 && (
        <p className="text-xs text-warning mb-2">Some checks could not run this period: {data.unavailableRules.join(', ')}.</p>
      )}
      {data.items.length === 0 ? (
        <ReportEmpty text={data.pipelinesEvaluated ? `Nothing tripped across ${data.pipelinesEvaluated} pipelines.` : 'No pipeline ran in this window.'} />
      ) : (
        <ul className="space-y-3">
          {data.items.map((item) => (
            <li key={item.pipelineId} className={`border-l-2 pl-3 ${item.severity === 'high' ? 'border-danger' : 'border-warning'}`}>
              <p className="text-sm font-medium text-fg">{pipelineLabel(item.pipelineName, item.pipelineId)}</p>
              <ul className="mt-0.5 space-y-0.5">
                {item.findings.map((f) => <li key={f.rule} className="text-xs text-fg-muted">{f.evidence}</li>)}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function FailureAnalysisBody({ data }: { data: FailureAnalysisData }) {
  if (data.categories.length === 0) return <ReportEmpty text="No categorized failures in this window." />;
  return (
    <>
      <p className="text-xs text-fg-subtle mb-3 tabular-nums">
        {data.total} failure{data.total === 1 ? '' : 's'} &middot; {data.actionableTotal} the team can act on
      </p>
      <div className="space-y-2.5">
        {data.categories.map((c) => (
          <div key={c.category}>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-fg truncate">
                {c.label}
                {!c.teamActionable && <span className="ml-2 text-2xs text-fg-subtle">(not team-actionable)</span>}
              </span>
              <span className="text-xs text-fg-subtle tabular-nums ml-2 shrink-0">
                {c.count} ({c.sharePct}%)
                {c.change !== null && c.change !== 0 && <span className={c.change > 0 ? 'text-danger ml-1' : 'text-success ml-1'}>{c.change > 0 ? `+${c.change}` : c.change}</span>}
              </span>
            </div>
            <div className="h-1 bg-surface-muted rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${c.teamActionable ? 'bg-red-500' : 'bg-gray-400'}`} style={{ width: `${Math.min(c.sharePct, 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PromotionBody({ data }: { data: PromotionData }) {
  if (data.commits.length === 0) return <ReportEmpty text="No commit-tagged deploys in this window." />;
  return (
    <>
      <p className="text-xs text-fg-subtle mb-3 tabular-nums">{data.stuckCount} of {data.commits.length} commits stopped short of production</p>
      <ul className="space-y-2">
        {data.commits.map((c) => (
          <li key={c.commitSha} className="text-sm flex flex-wrap items-center gap-x-2">
            <code className="text-xs">{shortSha(c.commitSha)}</code>
            <span className="text-fg-muted text-xs">{c.stops.map((s) => s.environment).join(' → ')}</span>
            {c.stuck && <span className="text-2xs font-semibold text-warning-strong">stuck at {c.furthest}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function ResourceBody({ data }: { data: ResourceConsumptionData }) {
  if (data.pipelines.length === 0) return <ReportEmpty text="No build time recorded in this window." />;
  return (
    <>
      <p className="text-xs text-fg-subtle mb-3 tabular-nums">{fmtBuildTime(data.totalBuildSeconds)} of build time in total</p>
      <div className="space-y-2.5">
        {data.pipelines.map((p) => (
          <div key={p.pipelineId}>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-fg truncate">{pipelineLabel(p.pipelineName, p.pipelineId)}</span>
              <span className="text-xs text-fg-subtle tabular-nums ml-2 shrink-0">{fmtBuildTime(p.buildSeconds)} &middot; {p.runs} runs ({p.sharePct}%)</span>
            </div>
            <div className="h-1 bg-surface-muted rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(p.sharePct, 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function OutdatedBody({ data }: { data: OutdatedPluginsData }) {
  if (data.rows.length === 0) return <ReportEmpty text="Every plugin step is on its latest version." />;
  return (
    <>
      <p className="text-xs text-fg-subtle mb-3 tabular-nums">{data.behindPipelines} pipeline{data.behindPipelines === 1 ? '' : 's'} behind &middot; {data.majorBehind} a major version behind</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-fg-subtle border-b border-default">
              <th scope="col" className="py-1.5 pr-3 font-medium">Pipeline</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Plugin</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">In use</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Latest</th>
              <th scope="col" className="py-1.5 font-medium">Gap</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.pipelineId}|${r.stageName}|${r.stepName}|${r.plugin}`} className="border-b border-default last:border-0">
                <td className="py-1.5 pr-3 text-fg">{pipelineLabel(r.pipelineName, r.pipelineId)}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{r.plugin}</td>
                <td className="py-1.5 pr-3 tabular-nums">{r.inUse ?? '—'}</td>
                <td className="py-1.5 pr-3 tabular-nums">{r.latest ?? '—'}</td>
                <td className="py-1.5">{r.gap ?? '—'}{!r.withinPolicy && <span className="ml-1 text-2xs text-danger">outside policy</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AdoptionBody({ data }: { data: AdoptionData }) {
  const tiles: Array<[string, ReactNode]> = [
    ['Active pipelines', `${data.activePipelines} of ${data.totalPipelines}`],
    ['Deploy-tracked', `${data.deployTrackedPipelines} of ${data.activePipelines}`],
    ['Active teams', data.activeTeams],
  ];
  if (data.estimatedMinutesSaved !== null) tiles.push(['Est. time saved', fmtBuildTime(data.estimatedMinutesSaved * 60)]);
  const sources = Object.entries(data.bySource).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        {tiles.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-fg-subtle">{label}</dt>
            <dd className="text-lg font-semibold text-fg tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {sources.length > 0 && (
        <p className="text-xs text-fg-muted">Created via: {sources.map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
      )}
    </>
  );
}

function SectionBody({ section }: { section: InsightSection }) {
  switch (section.id) {
    case 'needs_attention': return <NeedsAttentionBody data={section.data as NeedsAttentionData} />;
    case 'failure_analysis': return <FailureAnalysisBody data={section.data as FailureAnalysisData} />;
    case 'promotion': return <PromotionBody data={section.data as PromotionData} />;
    case 'resource_consumption': return <ResourceBody data={section.data as ResourceConsumptionData} />;
    case 'outdated_plugins': return <OutdatedBody data={section.data as OutdatedPluginsData} />;
    case 'adoption': return <AdoptionBody data={section.data as AdoptionData} />;
    default: return null;
  }
}

// ─── Upsell (non-entitled) ─────────────────────────────

/** The locked teaser, in the same shape as the DORA upsell. No fetch fires behind it. */
export function InsightsUpsell() {
  const meta = FEATURE_METADATA.advanced_reporting;
  return (
    <div>
      <SectionHeading>Insights</SectionHeading>
      <div className="relative overflow-hidden rounded-lg border border-default">
        {/* Blurred, inert sample behind the overlay — decorative only. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 blur-[3px] opacity-60 select-none pointer-events-none" aria-hidden="true">
          {CARDS.slice(0, 4).map((c) => (
            <Card key={c.id}>
              <p className="h3 mb-3">{c.title}</p>
              <div className="space-y-2">
                {[70, 45, 30].map((w) => <div key={w} className="h-2 rounded-full bg-surface-muted" style={{ width: `${w}%` }} />)}
              </div>
            </Card>
          ))}
        </div>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/70 backdrop-blur-[1px] px-6 py-8 text-center">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-info-bg text-brand">
            <Lock className="w-5 h-5" aria-hidden="true" />
          </span>
          <h4 className="text-base font-semibold text-fg">{meta.label} &mdash; Insights</h4>
          <p className="max-w-md text-sm text-fg-muted">
            See which pipelines need attention, what kind of failure is breaking builds, which commits stalled before
            production, where build time went, which plugins are behind and how widely pipelines are adopted &mdash;
            the same analysis your stakeholder reports carry, for any window. {meta.description}.
          </p>
          <LinkButton href="/dashboard/billing?highlight=advanced_reporting" size="sm" className="mt-1">
            Unlock Advanced Reporting
          </LinkButton>
        </div>
      </div>
    </div>
  );
}

// ─── Tab ───────────────────────────────────────────────

/**
 * Insights top-tab: the stakeholder report's analytics sections on demand, one
 * card per analysis. The backend runs the SAME registered section a report runs,
 * over the daily rollups, so the numbers match a report over the same window and
 * timezone (the tab buckets in the org's report timezone — see useReportBucketing).
 * A section that failed is isolated to its own card.
 */
export function InsightsTab({ filters, enabled, onStatus }: InsightsTabProps) {
  const { ready: bucketReady, tz, weekStart } = useReportBucketing();
  const params = useMemo(() => ({
    ...(filters.dateFrom ? { from: filters.dateFrom } : {}),
    ...(filters.dateTo ? { to: filters.dateTo } : {}),
    ...(filters.includeDescendants ? { includeDescendants: true } : {}),
    tz,
    ...(weekStart ? { weekStart } : {}),
  }), [filters.dateFrom, filters.dateTo, filters.includeDescendants, tz, weekStart]);
  const active = enabled && bucketReady;
  const { data, loading: fetching, error, refetch } = useFetch<InsightsResult | null>(
    (signal) => api.getInsights(params, { signal }),
    [active, JSON.stringify(params)],
    { enabled: active },
  );
  const loading = enabled && (!bucketReady || fetching);
  const errorMessage = error ? formatError(error, 'Failed to load insights') : null;
  useEffect(() => {
    onStatus({ loading, error: errorMessage, refetch: () => { void refetch(); } });
  }, [loading, errorMessage, refetch, onStatus]);

  if (!enabled) return <InsightsUpsell />;

  const byId = new Map((data?.sections ?? []).map((s) => [s.id, s]));
  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-subtle flex items-center gap-1.5">
        <Lightbulb className="w-3.5 h-3.5" aria-hidden="true" />
        The same analysis your stakeholder reports carry, computed from the daily rollups. Trends compare with the equal-length window before.
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {CARDS.map((card) => {
          const section = byId.get(card.id);
          if (!section) {
            if (loading) return <SectionCardSkeleton key={card.id} />;
            // A whole-tab error is on the shared banner; keep the card frame so the
            // layout does not collapse.
            return (
              <Card key={card.id}>
                <SectionHeading>{card.title}</SectionHeading>
                <ReportEmpty text={errorMessage ? 'Could not load this analysis.' : 'No data for this window.'} />
              </Card>
            );
          }
          return (
            <Card key={card.id} className={card.id === 'outdated_plugins' || card.id === 'needs_attention' ? 'lg:col-span-2' : undefined}>
              <div className="flex items-center justify-between mb-3">
                <SectionHeading>{section.title}</SectionHeading>
                {section.state === 'ok' && <ExportCSVButton data={insightCsvRows(card.id, section.data)} filename={card.csv} />}
              </div>
              {section.state === 'failed' || !section.data
                ? <ReportEmpty text="This analysis could not be computed for this window. The other cards are unaffected." />
                : <SectionBody section={section} />}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
