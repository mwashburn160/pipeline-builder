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
 *
 * READS GO TO THE REPLICA WHEN ONE EXISTS. Every query below runs through
 * `withTenantTxRead`, the read-only variant of `withTenantTx`. It sets the
 * identical RLS GUCs, adds `SET TRANSACTION READ ONLY`, and falls back to the
 * primary automatically whenever there is no replica, the kill switch is off,
 * replay lag is beyond its threshold, the request has already written, or there
 * is no tenant context — so this is a no-op until `DB_READ_HOST` is configured.
 *
 * WHY THIS FILE WAS THE FIRST TO OPT IN. Three conditions decide whether a
 * query may leave the primary, and this file satisfies all three by
 * construction — so they are stated here rather than cited, now that the plan
 * that introduced them is retired:
 *
 *   - Nothing here writes. Thirteen aggregate SELECTs, no INSERT, no UPDATE, no
 *     `SELECT … FOR UPDATE`, no advisory lock — none of the write-shaped calls
 *     that can hide behind read-looking code.
 *   - Nothing here feeds an AUTHORIZATION decision. These are dashboard
 *     aggregates; a stale permission check is a security bug, a stale chart is
 *     a stale chart.
 *   - Nobody is about to ACT on the result. A user who just created a pipeline
 *     looks for it in a list, not in a 30-day failure-rate rollup.
 *
 * And it is the best offload candidate for the same reason it is safe: these
 * are the heaviest queries in the package, scanning time ranges rather than
 * fetching rows by id.
 *
 * `SET TRANSACTION READ ONLY` applies on the PRIMARY path too, so if a write
 * is ever added below it fails here, loudly, rather than at whichever target
 * the read happened to land on.
 */

import { civilIn, instantOfCivil, isUsableTimeZone } from '@pipeline-builder/api-core';
import { and, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { FAILURE_CATEGORY_LABELS, isTeamActionable } from './failure-classifier.js';
import { liveExposurePredicate } from './plugin-exposure.js';
import { elevateRollup, orgScope } from './query-scope.js';
import { schema } from '../../database/drizzle-schema.js';
import { anyText } from '../../database/pg-result.js';
import type { FailureCategory } from '../../database/schema/reporting-analytics.js';
import { withTenantTxRead } from '../../database/tenancy.js';

/** The window and org scope every query takes. */
export interface AnalyticsScope {
  orgId: string;
  /** `[self, ...descendants]` for a rollup; undefined = this org only. */
  orgIds?: string[];
  from: string;
  to: string;
  /**
   * The report's IANA timezone. `execution_daily_rollups.day` is a UTC calendar
   * day stamped at UTC midnight, while `from`/`to` are LOCAL midnights in this
   * zone — so the day predicates compare against the period's local calendar
   * dates (see {@link rollupDayBound}), not the raw instants. Omitted = UTC.
   */
  tz?: string;
}

type ReadTx = Parameters<Parameters<typeof withTenantTxRead>[0]>[0];

/** What every analytics read is built from: the org predicate and the day bounds. */
interface ScopedRead {
  /** `= $org` or `= ANY($ids::text[])`, over {@link orgScope}'s validated ids. */
  org: SQL;
  /** The scope's org ids, as {@link orgScope} validated them. */
  ids: string[];
  /** Inclusive / exclusive bounds for `execution_daily_rollups.day` (UTC-midnight ISO). */
  dayFrom: string;
  dayTo: string;
}

const DAY_MS = 86_400_000;

/**
 * The UTC-midnight instant of the rollup `day` that a period bound maps to.
 *
 * A rollup `day` is the UTC calendar date D, stored as D at 00:00Z. A period
 * bound is an instant — normally a local midnight in `tz`. Comparing the two
 * directly is off by one day west of UTC (America/Chicago's Sept 1 starts at
 * 05:00Z, so `day >= from` drops the Sept 1 row and picks up Oct 1's), and east
 * of it the other way. So the bound is first read as a LOCAL calendar date in
 * `tz`, and that date's UTC-midnight stamp is what `day` is compared against.
 *
 * A bound that is not a local midnight rounds UP to the next date — the same
 * rule `day >= from AND day < to` applied in UTC: a partial first day is left
 * out, a partial last day kept. An unparseable bound passes through unchanged
 * (Postgres rejects it exactly as before).
 */
export function rollupDayBound(iso: string, tz = 'UTC'): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  const { year, month, day } = civilIn(instant, tz);
  const atLocalMidnight = instantOfCivil({ year, month, day }, tz).getTime() === instant.getTime();
  return new Date(Date.UTC(year, month - 1, day) + (atLocalMidnight ? 0 : DAY_MS)).toISOString();
}

/** Shift a UTC-midnight ISO bound by whole days. */
function dayShift(iso: string, days: number): string {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? iso : new Date(t + days * DAY_MS).toISOString();
}

/**
 * One analytics read. The org set comes from {@link orgScope} (anchor-validated,
 * server-resolved) and a multi-org rollup runs under the SAME sysadmin elevation
 * `runReport` uses for DORA and success rate ({@link elevateRollup}): FORCE RLS
 * on the rollup tables otherwise filters every child team's rows out of a parent
 * org's report, under the caller's own tenant. The `= ANY(ids)` predicate is
 * then the tenancy gate.
 */
function analyticsRead<T>(scope: AnalyticsScope, fn: (q: ScopedRead, tx: ReadTx) => Promise<T>): Promise<T> {
  const { ids, multi } = orgScope(scope.orgId, scope.orgIds);
  const tz = scope.tz && isUsableTimeZone(scope.tz) ? scope.tz : 'UTC';
  const q: ScopedRead = {
    org: multi ? sql`= ${anyText(ids)}` : sql`= ${ids[0]}`,
    ids,
    dayFrom: rollupDayBound(scope.from, tz),
    dayTo: rollupDayBound(scope.to, tz),
  };
  return elevateRollup(multi, () => withTenantTxRead((tx) => fn(q, tx)));
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
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    WITH totals AS (
      SELECT
        r.pipeline_id,
        SUM(r.runs)::int AS runs,
        SUM(r.succeeded)::int AS succeeded,
        SUM(r.failed)::int AS failed,
        MAX(r.p95_ms)::int AS p95_ms,
        SUM(r.build_seconds)::int AS build_seconds
      FROM execution_daily_rollups r
      WHERE r.org_id ${q.org}
        AND r.day >= ${q.dayFrom}::timestamptz AND r.day < ${q.dayTo}::timestamptz
        -- The pipeline-level grain only: summing the stage rows too would count
        -- every run once per stage.
        AND r.stage_name = ''
      GROUP BY r.pipeline_id
    ),
    deploys AS (
      SELECT pipeline_id, COUNT(*)::int AS deploys
      FROM dora_deployments
      WHERE org_id ${q.org}
        AND deployed_at >= ${scope.from}::timestamptz AND deployed_at < ${scope.to}::timestamptz
        AND succeeded = true
      GROUP BY pipeline_id
    ),
    last_fail AS (
      -- The most recent failing STAGE row per pipeline: what to look at first.
      SELECT DISTINCT ON (pipeline_id) pipeline_id, day, stage_name
      FROM execution_daily_rollups
      WHERE org_id ${q.org}
        AND day >= ${q.dayFrom}::timestamptz AND day < ${q.dayTo}::timestamptz
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
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    SELECT key AS category, SUM(value::int)::int AS count
    FROM execution_daily_rollups r, jsonb_each(r.failures_by_category)
    WHERE r.org_id ${q.org}
      AND r.day >= ${q.dayFrom}::timestamptz AND r.day < ${q.dayTo}::timestamptz
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
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
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
      WHERE r.org_id ${q.org}
        AND r.day >= ${q.dayFrom}::timestamptz AND r.day < ${q.dayTo}::timestamptz
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
  const rows = await analyticsRead(scope, (q, tx) => tx.select({
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
      q.ids.length > 1
        ? inArray(schema.executionDailyRollup.orgId, q.ids)
        : eq(schema.executionDailyRollup.orgId, q.ids[0] as string),
      eq(schema.executionDailyRollup.pipelineId, pipelineId),
      gte(schema.executionDailyRollup.day, new Date(q.dayFrom)),
      lt(schema.executionDailyRollup.day, new Date(q.dayTo)),
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
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    SELECT
      p.project,
      r.pipeline_id,
      p.pipeline_name,
      SUM(r.build_seconds)::int AS build_seconds,
      SUM(r.runs)::int AS runs
    FROM execution_daily_rollups r
    LEFT JOIN pipelines p ON p.id::text = r.pipeline_id
    WHERE r.org_id ${q.org}
      AND r.day >= ${q.dayFrom}::timestamptz AND r.day < ${q.dayTo}::timestamptz
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
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    SELECT commit_sha, environment, MIN(deployed_at) AS deployed_at
    FROM dora_deployments
    WHERE org_id ${q.org}
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
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    SELECT
      r.pipeline_id, p.pipeline_name, r.stage_name, r.step_name,
      COALESCE(r.plugin_publisher || '/', '') || r.plugin_name AS plugin,
      r.resolved_version, r.latest_version, r.version_gap, r.within_policy
    FROM pipeline_plugin_resolution r
    LEFT JOIN pipelines p ON p.id::text = r.pipeline_id
    WHERE r.org_id ${q.org}
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
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    SELECT
      v.pipeline_id, p.pipeline_name,
      COALESCE(v.plugin_publisher || '/', '') || v.plugin_name AS plugin,
      v.plugin_version, v.source, v.critical_count, v.high_count, v.top_findings, v.flagged_at
    FROM plugin_vuln_exposure v
    LEFT JOIN pipelines p ON p.id::text = v.pipeline_id
    WHERE v.org_id ${q.org}
      AND ${liveExposurePredicate(now, 'v')}
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
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    WITH scoped AS (
      SELECT id::text AS id, org_id, creation_source
      FROM pipelines
      WHERE org_id ${q.org}
        AND deleted_at IS NULL
    ),
    active AS (
      SELECT DISTINCT pipeline_id, org_id
      FROM execution_daily_rollups
      WHERE org_id ${q.org}
        AND day >= ${q.dayFrom}::timestamptz AND day < ${q.dayTo}::timestamptz
        AND stage_name = '' AND runs > 0
    ),
    tracked AS (
      SELECT DISTINCT pipeline_id
      FROM dora_deployments
      WHERE org_id ${q.org}
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

/** One pipeline's failure streak and last successful day. */
export interface PipelineStreakRow {
  pipelineId: string;
  /**
   * Failures in the trailing run of days on which NOTHING succeeded.
   *
   * A LOWER BOUND, and deliberately so. The rollup is per day, so within the most
   * recent day that did have a success there is no way to tell whether the failures
   * came before or after it — that day is excluded rather than guessed at. What
   * survives is a run of failures with no success anywhere between them, which is
   * exactly the claim the finding makes.
   */
  consecutiveFailures: number;
  /** The last day with at least one success, or null within the lookback. */
  lastSuccessAt: Date | null;
}

/**
 * Failure streaks and last-success dates, for the needs-attention rules.
 *
 * Reads the daily rollup, not `pipeline_events` — the same reason as everything
 * else here: a streak that ended three weeks ago must still be readable after
 * retention has swept the events that produced it.
 *
 * `lookbackDays` extends PAST the window on purpose. "Last succeeded 12 days ago"
 * is the finding a weekly report most needs, and a query bounded by a 7-day window
 * could never produce it.
 *
 * PIPELINE grain only (`stage_name = ''`). The rollup holds a pipeline-level row
 * AND one row per stage per day; summing them all counted every failed run once
 * for the pipeline and again for each failing stage (inflating the streak), and
 * let a succeeded STAGE of a failed run mark that day as a pipeline success.
 */
export async function getPipelineStreaks(
  scope: AnalyticsScope,
  lookbackDays = 90,
): Promise<PipelineStreakRow[]> {
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    WITH days AS (
      SELECT pipeline_id, day,
             SUM(succeeded)::int AS succeeded,
             SUM(failed)::int    AS failed
      FROM execution_daily_rollups
      WHERE org_id ${q.org}
        AND day >= ${dayShift(q.dayTo, -lookbackDays)}::timestamptz AND day < ${q.dayTo}::timestamptz
        AND stage_name = ''
      GROUP BY pipeline_id, day
    ),
    last_ok AS (
      SELECT pipeline_id, MAX(day) AS last_success_day
      FROM days WHERE succeeded > 0
      GROUP BY pipeline_id
    )
    SELECT d.pipeline_id,
           l.last_success_day,
           COALESCE(SUM(d.failed) FILTER (
             WHERE l.last_success_day IS NULL OR d.day > l.last_success_day
           ), 0)::int AS streak
    FROM days d
    LEFT JOIN last_ok l ON l.pipeline_id = d.pipeline_id
    GROUP BY d.pipeline_id, l.last_success_day
  `));
  return rowsOf(rows).map((r) => ({
    pipelineId: String(r.pipeline_id),
    consecutiveFailures: num(r.streak),
    lastSuccessAt: r.last_success_day ? new Date(String(r.last_success_day)) : null,
  }));
}

/**
 * Pipelines that RAN in the window but produced no deploy rows.
 *
 * A measurement gap, not a failure, and the reason a deployment-frequency number can
 * be quietly wrong: a pipeline whose deploy stages are not tagged (`pb.deploys`)
 * deploys perfectly well and is invisible to every DORA aggregate. Nothing else in the
 * report would say so.
 */
export async function getUntrackedPipelines(scope: AnalyticsScope): Promise<string[]> {
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    WITH active AS (
      SELECT pipeline_id
      FROM execution_daily_rollups
      WHERE org_id ${q.org}
        AND day >= ${q.dayFrom}::timestamptz AND day < ${q.dayTo}::timestamptz
        AND stage_name = ''
      GROUP BY pipeline_id
      HAVING SUM(runs) > 0
    ),
    tracked AS (
      SELECT DISTINCT pipeline_id
      FROM dora_deployments
      WHERE org_id ${q.org}
        AND deployed_at >= ${scope.from}::timestamptz AND deployed_at < ${scope.to}::timestamptz
    )
    SELECT a.pipeline_id FROM active a
    WHERE NOT EXISTS (SELECT 1 FROM tracked t WHERE t.pipeline_id = a.pipeline_id)
  `));
  return rowsOf(rows).map((r) => String(r.pipeline_id));
}

/**
 * Pipelines running a plugin version with an OPEN Critical exposure.
 *
 * Point-in-time, not windowed: what matters is whether the pipeline is running one
 * NOW. A Critical that was open last Tuesday and is fixed today is not something to
 * put in front of a manager, and `fixed_at` is what says so.
 *
 * The SAME live predicate as the vulnerability section (`liveExposurePredicate`):
 * an acceptance still in force and a false positive are excluded — someone with
 * the authority to decide has done so in writing — while an acceptance PAST its
 * deadline counts again, because that is what the deadline was for. The two
 * readers once disagreed (this one kept false positives and dropped expired
 * acceptances), so the panel and the needs-attention list contradicted each other.
 */
export async function getVulnerablePipelines(scope: AnalyticsScope): Promise<string[]> {
  const now = new Date();
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    SELECT DISTINCT pipeline_id
    FROM plugin_vuln_exposure
    WHERE org_id ${q.org}
      AND critical_count > 0
      AND ${liveExposurePredicate(now)}
  `));
  return rowsOf(rows).map((r) => String(r.pipeline_id));
}

/**
 * When each pipeline in the window was last changed.
 *
 * `pipelines.updated_at`, not an audit query: the audit trail lives in another store
 * with its own retention, and the one fact this needs — "was this touched shortly
 * before it broke" — is already on the row, durably, in the same transaction the
 * change was made in.
 *
 * The consequence is stated rather than hidden: `updated_at` moves for ANY write,
 * including a rename. So the finding says "after a configuration change", which is
 * true of a rename too, and does not claim to name the change.
 */
export async function getPipelineConfigChanges(scope: AnalyticsScope): Promise<Map<string, Date>> {
  const rows = await analyticsRead(scope, (q, tx) => tx.execute(sql`
    SELECT id::text AS id, updated_at
    FROM pipelines
    WHERE org_id ${q.org}
      AND deleted_at IS NULL
      AND updated_at IS NOT NULL
  `));
  const out = new Map<string, Date>();
  for (const r of rowsOf(rows)) {
    const at = r.updated_at ? new Date(String(r.updated_at)) : null;
    if (at && !Number.isNaN(at.getTime())) out.set(String(r.id), at);
  }
  return out;
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
