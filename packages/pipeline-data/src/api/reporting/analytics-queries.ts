// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The queries the bespoke report sections read.
 *
 * All of them go through `execution_daily_rollups`, `dora_deployments`,
 * `pipeline_plugin_resolution` or `plugin_vuln_exposure` — never raw
 * `pipeline_events`. That is the whole point of those tables: a quarterly report
 * over a busy org costs a few hundred rows, and keeps working after retention has
 * swept the events.
 *
 * TWO RULES EVERY QUERY HERE FOLLOWS:
 *
 *  - NOTHING IS PER-PERSON. Every aggregate is per pipeline, per stage, per
 *    category or per environment. The section registry refuses a per-person id at
 *    registration; these queries make sure there is nothing to register.
 *  - A ZERO AND A BLIND SPOT ARE DIFFERENT. Where a number can be absent for lack
 *    of data rather than lack of activity, the shape carries that (`null`, a
 *    `coverage` count, an explicit reason) instead of collapsing to 0.
 */

import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { FAILURE_CATEGORY_LABELS, isTeamActionable } from './failure-classifier.js';
import { schema } from '../../database/drizzle-schema.js';
import type { FailureCategory } from '../../database/schema/reporting-analytics.js';
import { withTenantTx } from '../../database/tenancy.js';

/** The window and org scope every query takes. */
export interface AnalyticsScope {
  orgId: string;
  /** `[self, ...descendants]` for a rollup; undefined = this org only. */
  orgIds?: string[];
  from: string;
  to: string;
}

/** The org predicate: one org, or a rollup set. */
function orgPredicate(col: Parameters<typeof inArray>[0], scope: AnalyticsScope) {
  return scope.orgIds && scope.orgIds.length > 0
    ? inArray(col, scope.orgIds)
    : eq(col as never, scope.orgId as never);
}

/** One pipeline's line in the breakdown. */
export interface PipelineBreakdownRow {
  pipelineId: string;
  pipelineName: string | null;
  project: string | null;
  runs: number;
  succeeded: number;
  failed: number;
  successPct: number | null;
  p95Ms: number | null;
  deploys: number;
  /** The most recent failure's day and stage, for "what to look at first". */
  lastFailureAt: string | null;
  lastFailureStage: string | null;
  buildSeconds: number;
}

/**
 * Per-pipeline delivery, worst first.
 *
 * WORST FIRST, and capped, because the point of the section is "where should
 * attention go". A list sorted by name, or an unbounded one, is a data dump: the
 * lead still has to find the problem, which is the work the report was supposed to
 * do. Ties break on volume, so a 50%-success pipeline that ran twice does not
 * outrank one that ran two hundred times.
 *
 * `successPct` is NULL for a pipeline with no runs in the window — not 0. A
 * pipeline nobody ran is not a pipeline that failed.
 */
export async function getPipelineBreakdown(scope: AnalyticsScope, limit = 10): Promise<PipelineBreakdownRow[]> {
  const rows = await withTenantTx((tx) => tx.execute(sql`
    WITH totals AS (
      SELECT
        r.pipeline_id,
        SUM(r.runs)::int AS runs,
        SUM(r.succeeded)::int AS succeeded,
        SUM(r.failed)::int AS failed,
        MAX(r.p95_ms)::int AS p95_ms,
        SUM(r.build_seconds)::int AS build_seconds
      FROM execution_daily_rollups r
      WHERE r.org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
        AND r.day >= ${scope.from}::timestamptz AND r.day < ${scope.to}::timestamptz
        -- The pipeline-level grain only: summing the stage rows too would count
        -- every run once per stage.
        AND r.stage_name = ''
      GROUP BY r.pipeline_id
    ),
    deploys AS (
      SELECT pipeline_id, COUNT(*)::int AS deploys
      FROM dora_deployments
      WHERE org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
        AND deployed_at >= ${scope.from}::timestamptz AND deployed_at < ${scope.to}::timestamptz
        AND succeeded = true
      GROUP BY pipeline_id
    ),
    last_fail AS (
      -- The most recent failing STAGE row per pipeline: what to look at first.
      SELECT DISTINCT ON (pipeline_id) pipeline_id, day, stage_name
      FROM execution_daily_rollups
      WHERE org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
        AND day >= ${scope.from}::timestamptz AND day < ${scope.to}::timestamptz
        AND stage_name <> '' AND failed > 0
      ORDER BY pipeline_id, day DESC, failed DESC
    )
    SELECT
      t.pipeline_id,
      p.pipeline_name,
      p.project,
      t.runs, t.succeeded, t.failed, t.p95_ms, t.build_seconds,
      COALESCE(d.deploys, 0) AS deploys,
      f.day AS last_failure_at,
      f.stage_name AS last_failure_stage,
      CASE WHEN t.runs > 0 THEN ROUND((t.succeeded::numeric / t.runs) * 100, 1) ELSE NULL END AS success_pct
    FROM totals t
    LEFT JOIN deploys d ON d.pipeline_id = t.pipeline_id
    LEFT JOIN last_fail f ON f.pipeline_id = t.pipeline_id
    LEFT JOIN pipelines p ON p.id::text = t.pipeline_id
    -- Worst first: lowest success rate, then most runs, so a 50% pipeline that ran
    -- twice does not outrank one that ran two hundred times.
    ORDER BY success_pct ASC NULLS LAST, t.runs DESC
    LIMIT ${limit}
  `));
  return rowsOf(rows).map((r) => ({
    pipelineId: String(r.pipeline_id),
    pipelineName: (r.pipeline_name as string | null) ?? null,
    project: (r.project as string | null) ?? null,
    runs: num(r.runs),
    succeeded: num(r.succeeded),
    failed: num(r.failed),
    successPct: r.success_pct === null ? null : Number(r.success_pct),
    p95Ms: r.p95_ms === null ? null : num(r.p95_ms),
    deploys: num(r.deploys),
    lastFailureAt: isoOrNull(r.last_failure_at),
    lastFailureStage: (r.last_failure_stage as string | null) ?? null,
    buildSeconds: num(r.build_seconds),
  }));
}

/** One failure category's share of the period. */
export interface FailureCategoryRow {
  category: FailureCategory;
  label: string;
  count: number;
  sharePct: number;
  /** Whether the team can act on it, or it happened to them. */
  teamActionable: boolean;
  /** Change vs the previous period, in failures. */
  change: number | null;
  /** The pipelines it hit hardest. */
  topPipelines: Array<{ pipelineId: string; pipelineName: string | null; count: number }>;
}

/**
 * Failures by category, with the previous period's counts for the trend.
 *
 * SPLITS ACTIONABLE FROM NOT. A week whose failures were all cloud throttling is a
 * different conversation from one whose failures were all broken tests, and
 * presenting them in one ranked list invites exactly the wrong conclusion — a team
 * being asked to fix an AWS capacity problem.
 */
export async function getFailureAnalysis(
  scope: AnalyticsScope,
  previous?: { from: string; to: string },
): Promise<{ categories: FailureCategoryRow[]; total: number; actionableTotal: number }> {
  const counts = await categoryCounts(scope);
  const prior = previous ? await categoryCounts({ ...scope, ...previous }) : null;
  const total = [...counts.values()].reduce((s, v) => s + v.count, 0);
  const topByCategory = await topPipelinesByCategory(scope);

  const categories = [...counts.entries()]
    .map(([category, v]) => ({
      category,
      label: FAILURE_CATEGORY_LABELS[category] ?? category,
      count: v.count,
      sharePct: total > 0 ? Number(((v.count / total) * 100).toFixed(1)) : 0,
      teamActionable: isTeamActionable(category),
      change: prior ? v.count - (prior.get(category)?.count ?? 0) : null,
      topPipelines: topByCategory.get(category) ?? [],
    }))
    .sort((a, b) => b.count - a.count);

  return {
    categories,
    total,
    actionableTotal: categories.filter((c) => c.teamActionable).reduce((s, c) => s + c.count, 0),
  };
}

async function categoryCounts(scope: AnalyticsScope): Promise<Map<FailureCategory, { count: number }>> {
  const rows = await withTenantTx((tx) => tx.execute(sql`
    SELECT key AS category, SUM(value::int)::int AS count
    FROM execution_daily_rollups r, jsonb_each(r.failures_by_category)
    WHERE r.org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
      AND r.day >= ${scope.from}::timestamptz AND r.day < ${scope.to}::timestamptz
      AND r.stage_name = ''
    GROUP BY key
  `));
  const out = new Map<FailureCategory, { count: number }>();
  for (const r of rowsOf(rows)) out.set(r.category as FailureCategory, { count: num(r.count) });
  return out;
}

async function topPipelinesByCategory(
  scope: AnalyticsScope,
  perCategory = 3,
): Promise<Map<FailureCategory, Array<{ pipelineId: string; pipelineName: string | null; count: number }>>> {
  const rows = await withTenantTx((tx) => tx.execute(sql`
    SELECT category, pipeline_id, pipeline_name, count FROM (
      SELECT
        e.key AS category,
        r.pipeline_id,
        p.pipeline_name,
        SUM(e.value::int)::int AS count,
        ROW_NUMBER() OVER (PARTITION BY e.key ORDER BY SUM(e.value::int) DESC) AS rn
      -- CROSS JOIN LATERAL, not a comma join. With FROM a, f(a.x) e LEFT JOIN b,
      -- the LEFT JOIN binds to e alone and r falls out of scope in its ON clause
      -- ("invalid reference to FROM-clause entry"). The explicit lateral keeps all
      -- three in one join tree.
      FROM execution_daily_rollups r
      CROSS JOIN LATERAL jsonb_each(r.failures_by_category) e
      LEFT JOIN pipelines p ON p.id::text = r.pipeline_id
      WHERE r.org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
        AND r.day >= ${scope.from}::timestamptz AND r.day < ${scope.to}::timestamptz
        AND r.stage_name = ''
      GROUP BY e.key, r.pipeline_id, p.pipeline_name
    ) ranked
    WHERE rn <= ${perCategory}
  `));
  const out = new Map<FailureCategory, Array<{ pipelineId: string; pipelineName: string | null; count: number }>>();
  for (const r of rowsOf(rows)) {
    const key = r.category as FailureCategory;
    const list = out.get(key) ?? [];
    list.push({
      pipelineId: String(r.pipeline_id),
      pipelineName: (r.pipeline_name as string | null) ?? null,
      count: num(r.count),
    });
    out.set(key, list);
  }
  return out;
}

/** One stage's timing, for the drill-down. */
export interface StagePerformanceRow {
  stageName: string;
  runs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Change in p95 vs the previous period, as a percentage. */
  p95ChangePct: number | null;
  failed: number;
}

/**
 * Per-stage timings for one pipeline, slowest first.
 *
 * The section a lead opens after the breakdown says a pipeline got slower: "which
 * stage" is the next question, and answering it from raw events would mean a
 * second scan of the same window.
 */
export async function getStagePerformance(
  scope: AnalyticsScope,
  pipelineId: string,
  previous?: { from: string; to: string },
): Promise<StagePerformanceRow[]> {
  const current = await stageRows(scope, pipelineId);
  const prior: Map<string, { p95Ms: number | null }> = previous
    ? new Map((await stageRows({ ...scope, ...previous }, pipelineId)).map((s) => [s.stageName, s]))
    : new Map();
  return current.map((s) => {
    const before = prior.get(s.stageName)?.p95Ms ?? null;
    return {
      ...s,
      p95ChangePct: before && before > 0 && s.p95Ms !== null
        ? Number((((s.p95Ms - before) / before) * 100).toFixed(1))
        : null,
    };
  }).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
}

interface StageRow { stageName: string; runs: number; p50Ms: number | null; p95Ms: number | null; failed: number }

async function stageRows(scope: AnalyticsScope, pipelineId: string): Promise<StageRow[]> {
  const rows = await withTenantTx((tx) => tx.select({
    stageName: schema.executionDailyRollup.stageName,
    runs: sql<number>`SUM(${schema.executionDailyRollup.runs})::int`,
    failed: sql<number>`SUM(${schema.executionDailyRollup.failed})::int`,
    // MAX of the daily p95s, not an average of percentiles: averaging
    // percentiles is not a percentile of anything, and the worst day is the
    // number somebody would act on.
    p50Ms: sql<number | null>`MAX(${schema.executionDailyRollup.p50Ms})::int`,
    p95Ms: sql<number | null>`MAX(${schema.executionDailyRollup.p95Ms})::int`,
  }).from(schema.executionDailyRollup)
    .where(and(
      orgPredicate(schema.executionDailyRollup.orgId, scope),
      eq(schema.executionDailyRollup.pipelineId, pipelineId),
      gte(schema.executionDailyRollup.day, new Date(scope.from)),
      lt(schema.executionDailyRollup.day, new Date(scope.to)),
      sql`${schema.executionDailyRollup.stageName} <> ''`,
    ))
    .groupBy(schema.executionDailyRollup.stageName));
  const map = new Map<string, StageRow>();
  for (const r of rows as Array<Record<string, unknown>>) {
    map.set(String(r.stageName), {
      stageName: String(r.stageName),
      runs: num(r.runs),
      failed: num(r.failed),
      p50Ms: r.p50Ms === null ? null : num(r.p50Ms),
      p95Ms: r.p95Ms === null ? null : num(r.p95Ms),
    });
  }
  return [...map.values()];
}

/** Build time by project and pipeline. No money anywhere. */
export interface ResourceRow {
  project: string | null;
  pipelineId: string;
  pipelineName: string | null;
  buildSeconds: number;
  runs: number;
  sharePct: number;
}

/**
 * Where the build time went.
 *
 * SECONDS, NOT DOLLARS. A cost figure needs the instance types, the spot/on-demand
 * mix and the account's own discounts, none of which this platform knows — so a
 * dollar number here would be a guess presented as an invoice. Build time is the
 * thing actually measured.
 */
export async function getResourceConsumption(scope: AnalyticsScope, limit = 20): Promise<{
  pipelines: ResourceRow[];
  totalBuildSeconds: number;
}> {
  const rows = await withTenantTx((tx) => tx.execute(sql`
    SELECT
      p.project,
      r.pipeline_id,
      p.pipeline_name,
      SUM(r.build_seconds)::int AS build_seconds,
      SUM(r.runs)::int AS runs
    FROM execution_daily_rollups r
    LEFT JOIN pipelines p ON p.id::text = r.pipeline_id
    WHERE r.org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
      AND r.day >= ${scope.from}::timestamptz AND r.day < ${scope.to}::timestamptz
      AND r.stage_name = ''
    GROUP BY p.project, r.pipeline_id, p.pipeline_name
    ORDER BY build_seconds DESC
    LIMIT ${limit}
  `));
  const list = rowsOf(rows);
  const total = list.reduce((s, r) => s + num(r.build_seconds), 0);
  return {
    totalBuildSeconds: total,
    pipelines: list.map((r) => ({
      project: (r.project as string | null) ?? null,
      pipelineId: String(r.pipeline_id),
      pipelineName: (r.pipeline_name as string | null) ?? null,
      buildSeconds: num(r.build_seconds),
      runs: num(r.runs),
      sharePct: total > 0 ? Number(((num(r.build_seconds) / total) * 100).toFixed(1)) : 0,
    })),
  };
}

/** One commit's journey across environments. */
export interface PromotionRow {
  commitSha: string;
  /** Environment → when it landed there, in the order it reached them. */
  stops: Array<{ environment: string; deployedAt: string; hoursFromPrevious: number | null }>;
  /** True when the commit reached a non-production environment and stopped. */
  stuck: boolean;
  furthest: string;
}

/**
 * Where commits got to, and where they stopped.
 *
 * "Stuck" is the number worth reading. A commit that reached staging four days ago
 * and never went further is work that is finished and not delivered — which does
 * not appear in deployment frequency, success rate or lead time, because by every
 * one of those measures nothing happened.
 */
export async function getPromotionView(
  scope: AnalyticsScope,
  productionEnv = 'production',
  limit = 25,
): Promise<{ commits: PromotionRow[]; stuckCount: number }> {
  const rows = await withTenantTx((tx) => tx.execute(sql`
    SELECT commit_sha, environment, MIN(deployed_at) AS deployed_at
    FROM dora_deployments
    WHERE org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
      AND deployed_at >= ${scope.from}::timestamptz AND deployed_at < ${scope.to}::timestamptz
      AND succeeded = true
      AND commit_sha IS NOT NULL
    GROUP BY commit_sha, environment
    ORDER BY MIN(deployed_at) DESC
  `));

  const byCommit = new Map<string, Array<{ environment: string; deployedAt: Date }>>();
  for (const r of rowsOf(rows)) {
    const sha = String(r.commit_sha);
    const list = byCommit.get(sha) ?? [];
    list.push({ environment: String(r.environment), deployedAt: new Date(String(r.deployed_at)) });
    byCommit.set(sha, list);
  }

  const commits: PromotionRow[] = [...byCommit.entries()].map(([commitSha, raw]) => {
    const ordered = [...raw].sort((a, b) => a.deployedAt.getTime() - b.deployedAt.getTime());
    const stops = ordered.map((stop, i) => ({
      environment: stop.environment,
      deployedAt: stop.deployedAt.toISOString(),
      hoursFromPrevious: i === 0
        ? null
        : Number(((stop.deployedAt.getTime() - (ordered[i - 1] as { deployedAt: Date }).deployedAt.getTime()) / 3600_000).toFixed(1)),
    }));
    const furthest = ordered[ordered.length - 1]?.environment ?? '';
    return { commitSha, stops, furthest, stuck: furthest !== productionEnv };
  })
    .sort((a, b) => {
      const aLast = a.stops[a.stops.length - 1]?.deployedAt ?? '';
      const bLast = b.stops[b.stops.length - 1]?.deployedAt ?? '';
      return bLast.localeCompare(aLast);
    })
    .slice(0, limit);

  return { commits, stuckCount: commits.filter((c) => c.stuck).length };
}

/** Outdated plugin usage, per pipeline and step. */
export interface OutdatedPluginRow {
  pipelineId: string;
  pipelineName: string | null;
  stageName: string;
  stepName: string;
  plugin: string;
  inUse: string | null;
  latest: string | null;
  gap: string | null;
  withinPolicy: boolean;
}

/**
 * Which pipelines are behind on a plugin, worst gap first.
 *
 * Reads the DECLARED side (`pipeline_plugin_resolution`). A pipeline's declared
 * range and what it last actually ran can disagree — which is why the vulnerability
 * section below reads the deployed side and says which it is showing.
 */
export async function getOutdatedPlugins(scope: AnalyticsScope, limit = 50): Promise<{
  rows: OutdatedPluginRow[];
  behindPipelines: number;
  majorBehind: number;
}> {
  const rows = await withTenantTx((tx) => tx.execute(sql`
    SELECT
      r.pipeline_id, p.pipeline_name, r.stage_name, r.step_name,
      COALESCE(r.plugin_publisher || '/', '') || r.plugin_name AS plugin,
      r.resolved_version, r.latest_version, r.version_gap, r.within_policy
    FROM pipeline_plugin_resolution r
    LEFT JOIN pipelines p ON p.id::text = r.pipeline_id
    WHERE r.org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
      AND (r.version_gap IN ('major', 'minor', 'patch') OR r.within_policy = false)
    ORDER BY CASE r.version_gap WHEN 'major' THEN 0 WHEN 'minor' THEN 1 WHEN 'patch' THEN 2 ELSE 3 END,
             r.pipeline_id
    LIMIT ${limit}
  `));
  const list = rowsOf(rows).map((r) => ({
    pipelineId: String(r.pipeline_id),
    pipelineName: (r.pipeline_name as string | null) ?? null,
    stageName: String(r.stage_name),
    stepName: String(r.step_name),
    plugin: String(r.plugin),
    inUse: (r.resolved_version as string | null) ?? null,
    latest: (r.latest_version as string | null) ?? null,
    gap: (r.version_gap as string | null) ?? null,
    withinPolicy: r.within_policy !== false,
  }));
  return {
    rows: list,
    behindPipelines: new Set(list.map((r) => r.pipelineId)).size,
    majorBehind: list.filter((r) => r.gap === 'major').length,
  };
}

/** A pipeline's exposure to a vulnerable plugin version. */
export interface VulnerabilityRow {
  pipelineId: string;
  pipelineName: string | null;
  plugin: string;
  version: string;
  /** `deployed` = what actually ran; `declared` = what the config asks for. */
  source: string;
  critical: number;
  high: number;
  findings: Array<Record<string, unknown>>;
  flaggedAt: string;
}

/**
 * Plugin vulnerabilities, per pipeline, Criticals first.
 *
 * SAYS WHETHER IT IS DECLARED OR DEPLOYED. A pipeline whose config was updated to a
 * fixed version but which has not re-synthed is still running the vulnerable image,
 * and a report that collapsed the two would tell a manager the problem is solved
 * while the old image keeps running.
 */
export async function getPluginVulnerabilities(scope: AnalyticsScope, limit = 50): Promise<{
  rows: VulnerabilityRow[];
  exposedPipelines: number;
  criticalPipelines: number;
}> {
  const now = new Date();
  const rows = await withTenantTx((tx) => tx.execute(sql`
    SELECT
      v.pipeline_id, p.pipeline_name,
      COALESCE(v.plugin_publisher || '/', '') || v.plugin_name AS plugin,
      v.plugin_version, v.source, v.critical_count, v.high_count, v.top_findings, v.flagged_at
    FROM plugin_vuln_exposure v
    LEFT JOIN pipelines p ON p.id::text = v.pipeline_id
    WHERE v.org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
      AND v.fixed_at IS NULL
      -- An acceptance past its deadline is not an acceptance.
      AND (v.triage_state NOT IN ('accepted', 'false_positive')
           OR (v.triage_state = 'accepted' AND v.accepted_until IS NOT NULL AND v.accepted_until <= ${now}))
    ORDER BY v.critical_count DESC, v.high_count DESC
    LIMIT ${limit}
  `));
  const list = rowsOf(rows).map((r) => ({
    pipelineId: String(r.pipeline_id),
    pipelineName: (r.pipeline_name as string | null) ?? null,
    plugin: String(r.plugin),
    version: String(r.plugin_version),
    source: String(r.source),
    critical: num(r.critical_count),
    high: num(r.high_count),
    findings: (r.top_findings as Array<Record<string, unknown>>) ?? [],
    flaggedAt: isoOrNull(r.flagged_at) ?? new Date(0).toISOString(),
  }));
  return {
    rows: list,
    exposedPipelines: new Set(list.map((r) => r.pipelineId)).size,
    criticalPipelines: new Set(list.filter((r) => r.critical > 0).map((r) => r.pipelineId)).size,
  };
}

/** Adoption and deploy-tracking coverage within the reported scope. */
export interface AdoptionSummary {
  activePipelines: number;
  totalPipelines: number;
  /** Pipelines that produced a deploy row — i.e. ones DORA can see. */
  deployTrackedPipelines: number;
  /** By `creation_source`, for "are the golden paths being used". */
  bySource: Record<string, number>;
  /** Teams in the rollup that had activity. 1 for a single-org report. */
  activeTeams: number;
  /** Only when the org configured the assumption. Never platform-supplied. */
  estimatedMinutesSaved: number | null;
}

/**
 * Adoption, coverage and creation source.
 *
 * `deployTrackedPipelines` is the honest denominator for everything DORA says: a
 * pipeline that has not re-synthed with deploy tags produces no deploy rows, so it
 * is invisible to deployment frequency — and reporting "4 deploys" without saying
 * that 20 of 30 pipelines cannot be seen is the single most misleading thing this
 * feature could do.
 */
export async function getAdoption(scope: AnalyticsScope, timeSavedMinutes?: number | null): Promise<AdoptionSummary> {
  const rows = await withTenantTx((tx) => tx.execute(sql`
    WITH scoped AS (
      SELECT id::text AS id, org_id, creation_source
      FROM pipelines
      WHERE org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
        AND deleted_at IS NULL
    ),
    active AS (
      SELECT DISTINCT pipeline_id, org_id
      FROM execution_daily_rollups
      WHERE org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
        AND day >= ${scope.from}::timestamptz AND day < ${scope.to}::timestamptz
        AND stage_name = '' AND runs > 0
    ),
    tracked AS (
      SELECT DISTINCT pipeline_id
      FROM dora_deployments
      WHERE org_id ${scope.orgIds?.length ? sql`= ANY(${scope.orgIds})` : sql`= ${scope.orgId}`}
        AND deployed_at >= ${scope.from}::timestamptz AND deployed_at < ${scope.to}::timestamptz
    )
    SELECT
      (SELECT COUNT(*) FROM scoped)::int AS total_pipelines,
      (SELECT COUNT(*) FROM active)::int AS active_pipelines,
      (SELECT COUNT(DISTINCT org_id) FROM active)::int AS active_teams,
      (SELECT COUNT(*) FROM tracked)::int AS deploy_tracked,
      (SELECT COALESCE(jsonb_object_agg(COALESCE(creation_source, 'unknown'), n), '{}'::jsonb)
         FROM (SELECT creation_source, COUNT(*)::int AS n FROM scoped GROUP BY creation_source) s
      ) AS by_source
  `));
  const r = rowsOf(rows)[0] ?? {};
  const created = num(r.total_pipelines);
  return {
    totalPipelines: created,
    activePipelines: num(r.active_pipelines),
    activeTeams: Math.max(1, num(r.active_teams)),
    deployTrackedPipelines: num(r.deploy_tracked),
    bySource: (r.by_source as Record<string, number>) ?? {},
    // Only when the ORG configured the assumption — a platform-supplied number
    // here would be the platform marking its own homework.
    estimatedMinutesSaved: timeSavedMinutes && timeSavedMinutes > 0 ? created * timeSavedMinutes : null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Rows from a raw `execute`, whichever shape the driver returned. */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

/** A count from a driver that may hand back a string for a bigint. */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
