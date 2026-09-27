// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The section registry: the one place that maps a report section id to the
 * ReportingService method that computes it.
 *
 * Why a registry rather than each template calling the service directly:
 *
 *  - The numbers in a report MUST match the dashboard. A manager who compares the
 *    two and finds a difference stops trusting both, so both read the same query —
 *    there is no separate "report" implementation of success rate.
 *  - Feature gating belongs with the section, not the route. DORA sections need
 *    `advanced_reporting`; a report that includes one without the add-on renders a
 *    LOCKED section and still delivers, rather than failing the whole run. A run
 *    that dies because of one gated section is a support ticket; a locked panel is
 *    an upsell.
 *  - Per-person metrics are refused HERE, at registration. Ranking individual
 *    developers destroys trust in the whole report, and a guideline in a document
 *    does not stop someone adding `topCommitters` later — a throwing registry does.
 */

import type { FeatureFlag } from '@pipeline-builder/api-core';
import type { AnalyticsScope } from '../analytics-queries.js';

/** What a section needs to run one period's query. */
export interface SectionContext {
  orgId: string;
  /** Rollup org ids, when the definition's scope is a team rollup. */
  orgIds?: string[];
  /** Period bounds as ISO strings, which is what every service method takes. */
  from: string;
  to: string;
  /** The report's bucketing settings, for the time-series sections. */
  tz: string;
  weekStart: 'monday' | 'sunday';
  /**
   * The PREVIOUS period's bounds, for the sections that compute their own trend
   * internally rather than being run twice.
   *
   * Most sections are simply re-run over the previous window by the composer and
   * compared on a single headline. The analytics sections cannot be: their trend is
   * per category, per stage or per pipeline, and comparing two whole result sets
   * afterwards would mean re-implementing the join in the composer.
   */
  previousFrom?: string;
  previousTo?: string;
}

/** The service surface a section is allowed to call. Structural on purpose: the
 *  registry never imports the service, so it stays testable with a stub. */
export interface SectionDataSource {
  getExecutionCount(orgId: string, orgIds?: string[], range?: { from?: string; to?: string }): Promise<unknown>;
  getSuccessRate(orgId: string, interval: string, from: string, to: string, orgIds?: string[], bucket?: { tz?: string; weekStart?: 'monday' | 'sunday' }): Promise<unknown>;
  getAverageDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<unknown>;
  getStageFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<unknown>;
  getStageBottlenecks(orgId: string, from: string, to: string, orgIds?: string[]): Promise<unknown>;
  getActionFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<unknown>;
  getErrors(orgId: string, from: string, to: string, limit?: number, orgIds?: string[]): Promise<unknown>;
  getPluginSummary(orgId: string): Promise<unknown>;
  getPluginDistribution(orgId: string): Promise<unknown>;
  getPluginVersions(orgId: string): Promise<unknown>;
  getBuildSuccessRate(orgId: string, interval: string, from: string, to: string, orgIds?: string[], bucket?: { tz?: string; weekStart?: 'monday' | 'sunday' }): Promise<unknown>;
  getBuildDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<unknown>;
  getBuildFailures(orgId: string, from: string, to: string, limit?: number, orgIds?: string[]): Promise<unknown>;
  getDoraMetrics(orgId: string, from: string, to: string, orgIds?: string[], opts?: Record<string, unknown>): Promise<unknown>;
  getDoraTrend(orgId: string, interval: string, from: string, to: string, orgIds?: string[], opts?: Record<string, unknown>): Promise<unknown>;
  getBuildHealth(orgId: string, pipelineId: string, from: string, to: string): Promise<unknown>;
  getReportEnvironments(orgId: string, from: string, to: string, orgIds?: string[]): Promise<unknown>;

  // ── The ANALYTICS reads (the rollup tables, not raw events) ───────────────
  // Separate from the on-demand dashboard methods above because they answer
  // questions the dashboard never asked: which pipeline needs attention, what
  // kind of thing is breaking, where build time went, which commits are stuck.
  // Every one reads a pre-aggregated table, so a quarterly report stays a
  // few-hundred-row query and keeps working after retention sweeps the events.
  getPipelineBreakdown(scope: AnalyticsScope, limit?: number): Promise<unknown>;
  getFailureAnalysis(scope: AnalyticsScope, previous?: { from: string; to: string }): Promise<unknown>;
  getStagePerformance(scope: AnalyticsScope, pipelineId: string, previous?: { from: string; to: string }): Promise<unknown>;
  getResourceConsumption(scope: AnalyticsScope, limit?: number): Promise<unknown>;
  getPromotionView(scope: AnalyticsScope, productionEnv?: string, limit?: number): Promise<unknown>;
  getOutdatedPlugins(scope: AnalyticsScope, limit?: number): Promise<unknown>;
  getPluginVulnerabilities(scope: AnalyticsScope, limit?: number): Promise<unknown>;
  getAdoption(scope: AnalyticsScope, timeSavedMinutes?: number | null): Promise<unknown>;
  /** Compliance + access posture, over a service-to-service read. Degrades. */
  getCompliancePosture?(scope: AnalyticsScope): Promise<unknown>;
  /** The evaluated needs-attention findings for the period. */
  getNeedsAttention?(scope: AnalyticsScope, previous?: { from: string; to: string }): Promise<unknown>;
}

/** One registered section. */
export interface SectionSpec {
  id: string;
  /** Manager-facing title. Not a metric name — "Deploys", not "deployment_frequency". */
  title: string;
  /** Feature the org must hold, or undefined for a free section. */
  requiresFeature?: FeatureFlag;
  /**
   * True when this section's value is a single comparable number, so the composer
   * can compute period-over-period change. A list section (top failures) has no
   * meaningful "change", and pretending otherwise produces nonsense arrows.
   */
  comparable: boolean;
  run(source: SectionDataSource, ctx: SectionContext): Promise<unknown>;
}

/**
 * Ids that would rank or compare INDIVIDUAL people. Refused at registration.
 *
 * Team-level metrics describe a system; per-person metrics describe a person, and
 * a report a manager reads is the worst possible place for the second. Once a
 * developer believes the weekly report ranks them, the numbers start being gamed
 * and the report stops describing reality.
 */
const PER_PERSON_MARKERS = ['author', 'committer', 'developer', 'person', 'user', 'individual', 'by_member', 'per_member'];

/** Throws when a section id looks per-person. */
function assertNotPerPerson(id: string): void {
  const lowered = id.toLowerCase();
  const hit = PER_PERSON_MARKERS.find((m) => lowered.includes(m));
  if (hit) {
    throw new Error(
      `Refusing to register report section "${id}": it looks per-person ("${hit}"). `
      + 'Stakeholder reports are team-level by design — ranking individuals in a report a '
      + 'manager reads destroys trust in every other number in it. Aggregate to the team.',
    );
  }
}

/** The scope every analytics query takes, from the section context. */
function scopeOf(c: SectionContext): AnalyticsScope {
  return { orgId: c.orgId, ...(c.orgIds ? { orgIds: c.orgIds } : {}), from: c.from, to: c.to };
}

/** The previous period, when the context carries one (for the trend columns). */
function previousOf(c: SectionContext): { from: string; to: string } | undefined {
  return c.previousFrom && c.previousTo ? { from: c.previousFrom, to: c.previousTo } : undefined;
}

const REGISTRY = new Map<string, SectionSpec>();

/** Register a section. Throws on a duplicate id or a per-person one. */
export function registerSection(spec: SectionSpec): SectionSpec {
  assertNotPerPerson(spec.id);
  if (REGISTRY.has(spec.id)) throw new Error(`Duplicate report section id: ${spec.id}`);
  REGISTRY.set(spec.id, spec);
  return spec;
}

/** Look a section up; undefined when the id is unknown. */
export function getSection(id: string): SectionSpec | undefined {
  return REGISTRY.get(id);
}

/** Every registered section, in registration order. */
export function allSections(): SectionSpec[] {
  return [...REGISTRY.values()];
}

/** The ids a caller may put in a definition. */
export function sectionIds(): string[] {
  return [...REGISTRY.keys()];
}

// ── Delivery ────────────────────────────────────────────────────────────────

registerSection({
  id: 'execution_count',
  title: 'Pipeline runs',
  comparable: true,
  run: (s, c) => s.getExecutionCount(c.orgId, c.orgIds, { from: c.from, to: c.to }),
});

registerSection({
  id: 'success_rate',
  title: 'Success rate',
  comparable: true,
  run: (s, c) => s.getSuccessRate(c.orgId, 'week', c.from, c.to, c.orgIds, { tz: c.tz, weekStart: c.weekStart }),
});

registerSection({
  id: 'duration',
  title: 'Run duration',
  comparable: true,
  run: (s, c) => s.getAverageDuration(c.orgId, c.from, c.to, c.orgIds),
});

// ── What is blocking us ─────────────────────────────────────────────────────

registerSection({
  id: 'stage_failures',
  title: 'Top failing stages',
  // A list, not a number: "change" on a top-N list is meaningless.
  comparable: false,
  run: (s, c) => s.getStageFailures(c.orgId, c.from, c.to, c.orgIds),
});

registerSection({
  id: 'stage_bottlenecks',
  title: 'Slowest stages',
  comparable: false,
  run: (s, c) => s.getStageBottlenecks(c.orgId, c.from, c.to, c.orgIds),
});

registerSection({
  id: 'action_failures',
  title: 'Top failing steps',
  comparable: false,
  run: (s, c) => s.getActionFailures(c.orgId, c.from, c.to, c.orgIds),
});

registerSection({
  id: 'errors',
  title: 'Recent failures',
  comparable: false,
  // Capped: a manager reads the top few, and the snapshot is stored forever.
  run: (s, c) => s.getErrors(c.orgId, c.from, c.to, 10, c.orgIds),
});

// ── Plugin / supply-chain posture ───────────────────────────────────────────

registerSection({
  id: 'plugin_summary',
  title: 'Plugins in use',
  comparable: true,
  run: (s, c) => s.getPluginSummary(c.orgId),
});

registerSection({
  id: 'plugin_distribution',
  title: 'Plugin mix',
  comparable: false,
  run: (s, c) => s.getPluginDistribution(c.orgId),
});

registerSection({
  id: 'plugin_versions',
  title: 'Outdated plugins',
  comparable: true,
  run: (s, c) => s.getPluginVersions(c.orgId),
});

// ── Build health ────────────────────────────────────────────────────────────

registerSection({
  id: 'build_success_rate',
  title: 'Plugin build success',
  comparable: true,
  run: (s, c) => s.getBuildSuccessRate(c.orgId, 'week', c.from, c.to, c.orgIds, { tz: c.tz, weekStart: c.weekStart }),
});

registerSection({
  id: 'build_duration',
  title: 'Plugin build duration',
  comparable: true,
  run: (s, c) => s.getBuildDuration(c.orgId, c.from, c.to, c.orgIds),
});

registerSection({
  id: 'build_failures',
  title: 'Plugin build failures',
  comparable: false,
  run: (s, c) => s.getBuildFailures(c.orgId, c.from, c.to, 10, c.orgIds),
});

// ── Deploy / DORA (paid) ────────────────────────────────────────────────────
// These need `advanced_reporting`. Without it the composer renders a locked
// section and the rest of the report still delivers.

registerSection({
  id: 'dora',
  title: 'Delivery metrics (DORA)',
  requiresFeature: 'advanced_reporting',
  comparable: true,
  run: (s, c) => s.getDoraMetrics(c.orgId, c.from, c.to, c.orgIds),
});

registerSection({
  id: 'dora_trend',
  title: 'Delivery trend',
  requiresFeature: 'advanced_reporting',
  comparable: false,
  run: (s, c) => s.getDoraTrend(c.orgId, 'week', c.from, c.to, c.orgIds, { tz: c.tz, weekStart: c.weekStart }),
});

registerSection({
  id: 'environments',
  title: 'Deploy environments',
  comparable: false,
  run: (s, c) => s.getReportEnvironments(c.orgId, c.from, c.to, c.orgIds),
});

// ── The analytics sections ──────────────────────────────────────────────────
// Each reads a pre-aggregated table rather than raw events, and each answers a
// question the on-demand dashboards do not: not "how are we doing" but "what
// should somebody do about it".

registerSection({
  id: 'pipeline_breakdown',
  title: 'Pipelines needing the most attention',
  comparable: false,
  run: (s, c) => s.getPipelineBreakdown(scopeOf(c), 10),
});

/**
 * The section that DECIDES rather than describes. Its findings carry the number
 * behind them, because a flag without evidence is an opinion the reader has to take
 * on trust — and the first time one is wrong the section stops being read.
 */
registerSection({
  id: 'needs_attention',
  title: 'Needs attention',
  comparable: false,
  run: (s, c) => (s.getNeedsAttention
    ? s.getNeedsAttention(scopeOf(c), previousOf(c))
    : Promise.resolve({ items: [], unavailable: 'needs-attention evaluation is not wired in this context' })),
});

registerSection({
  id: 'failure_analysis',
  title: 'What is breaking',
  comparable: false,
  run: (s, c) => s.getFailureAnalysis(scopeOf(c), previousOf(c)),
});

registerSection({
  id: 'stage_performance',
  title: 'Slowest stages',
  comparable: false,
  // The worst pipeline from the breakdown is the one worth drilling into; a
  // section that asked for a pipeline id would have nothing to put in it on a
  // scheduled run, where there is no user to pick one.
  run: async (s, c) => {
    const breakdown = await s.getPipelineBreakdown(scopeOf(c), 1) as Array<{ pipelineId?: string }>;
    const worst = breakdown[0]?.pipelineId;
    if (!worst) return { stages: [], pipelineId: null };
    return { pipelineId: worst, stages: await s.getStagePerformance(scopeOf(c), worst, previousOf(c)) };
  },
});

registerSection({
  id: 'promotion',
  title: 'What reached production, and what did not',
  comparable: false,
  run: (s, c) => s.getPromotionView(scopeOf(c)),
});

registerSection({
  id: 'resource_consumption',
  title: 'Where the build time went',
  comparable: false,
  run: (s, c) => s.getResourceConsumption(scopeOf(c), 20),
});

registerSection({
  id: 'outdated_plugins',
  title: 'Plugins behind their latest version',
  comparable: false,
  run: (s, c) => s.getOutdatedPlugins(scopeOf(c), 50),
});

registerSection({
  id: 'plugin_vulnerabilities',
  title: 'Plugin vulnerabilities',
  comparable: false,
  run: (s, c) => s.getPluginVulnerabilities(scopeOf(c), 50),
});

registerSection({
  id: 'adoption',
  title: 'Adoption and coverage',
  comparable: false,
  run: (s, c) => s.getAdoption(scopeOf(c)),
});

/**
 * Compliance and access posture, read from the compliance and platform services
 * over a service-to-service call.
 *
 * DEGRADES rather than failing the run: if compliance is unreachable the section
 * says "unavailable" and the rest of the report still reaches the lead. A weekly
 * report that did not arrive because one optional panel's upstream was down is a
 * support ticket; a panel that says it could not be computed is information.
 */
registerSection({
  id: 'compliance_posture',
  title: 'Compliance and access posture',
  comparable: false,
  run: (s, c) => (s.getCompliancePosture
    ? s.getCompliancePosture(scopeOf(c))
    : Promise.resolve({ unavailable: 'compliance posture is not available in this context' })),
});
