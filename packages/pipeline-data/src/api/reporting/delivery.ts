// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Delivery reports: run latency and runner reliability (free), and the
 * deployment calendar and change volume (advanced).
 *
 * RUNNER RELIABILITY reads `pipeline_run_requests` (one row per signed start /
 * stop a user or the system asked a cross-account runner to perform) and
 * `pipeline_runners`. Both are pipeline-owned and read-only here.
 *
 *  - WHAT COUNTS. `start` and `stop` requests only: a `probe` is runner
 *    discovery, not a run anyone asked for, and counting its `NO_MATCH`
 *    answers as failures would make every newly registered pipeline look like
 *    an outage. Windowed on `requested_at`, `[from, to)`.
 *  - OUTCOMES. `started` / `stopped` → started (the runner accepted it);
 *    `expired` → expired (never delivered within the request's lifetime);
 *    `failed` with a runner refusal (a runner-category 401/403 in the
 *    RUNNER_ERRORS catalog: bad signature, refused, permission denied) →
 *    refused; any other `failed` → failed; `queued` / `delivering` → pending.
 *    The failure rate is (failed + expired + refused) / everything that
 *    finished; pending requests are in neither side.
 *  - LATENCY. The request row has no "answered at" timestamp, so the time to
 *    acceptance is measured as request → the START of the execution the runner
 *    reported (`result_execution_id`, matched to the earliest ingested event of
 *    that execution). CodePipeline stamps that start while the runner's
 *    StartPipelineExecution call is in flight, so it bounds the acceptance
 *    from above by at most the runner's own call. Start requests whose
 *    execution has no ingested events are not in the sample (`n` says how many
 *    are).
 *  - FAILURE CODES. Bounded by api-core's RUNNER_ERRORS catalog: a stored code
 *    outside it (an older runner's, a typo) is counted as `OTHER`, so the list
 *    can never carry free text.
 *  - RUNNERS. Every runner the scope's requests went through, plus the scope's
 *    own non-revoked runners (with zeros when idle). A runner owned OUTSIDE the
 *    scope (a parent's runner shared with this team) shows its label and
 *    health the way the team's runner list shows them, and only while it is
 *    still shared with teams; once unshared it is an unnamed row. No function
 *    URL, signing key, requester or AWS identifier is ever selected.
 *
 * DEPLOYMENT CALENDAR reads `dora_deployments` (one row per org, execution and
 * environment, kept past event retention): deployments per local day per
 * environment, commits per deploy, and the range's production deploys. A
 * production deploy's outcome is `failed` when the deploy itself failed,
 * `post_deploy_failure` when someone marked it failed afterwards (a
 * `deployment_outcomes` marker), else `succeeded`. Incident-correlated
 * failures are the DORA tab's change-failure rate, not this list.
 *
 * Both reports are org-scoped and rollup-aware (the same anchor-validated org
 * set and elevation as the security reads) and team-level only: nothing per
 * person is read or returned.
 */

import { RUNNER_ERRORS, isRunnerErrorCode, type RunnerErrorCategory, type RunnerHealth, type RunnerStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { sql } from 'drizzle-orm';
import { HEADLINE_ENV } from './dora-scoring.js';
import { orgScope } from './query-scope.js';
import { bucketSeries, num, safeTz, securityRead, type SecurityBucket, type SecurityScope } from './security.js';
import { periodBucket, assertReportInterval } from './sql-helpers.js';
import { anyText, resultRows } from '../../database/pg-result.js';
import { runWithTenantContext, withTenantTxRead } from '../../database/tenancy.js';

/** The org + window every Delivery read takes. */
export type DeliveryScope = SecurityScope;
/** Bucketing for the runner series. */
export type DeliveryBucket = SecurityBucket;

/** How a run request ended (or that it has not yet). */
export type RunRequestOutcome = 'started' | 'failed' | 'expired' | 'refused' | 'pending';

/** Runner refusals: the runner-category answers that mean "I will not do this for you". */
export const RUNNER_REFUSAL_CODES = (Object.keys(RUNNER_ERRORS) as Array<keyof typeof RUNNER_ERRORS>)
  .filter((k) => RUNNER_ERRORS[k].category === 'runner' && (RUNNER_ERRORS[k].httpStatus === 401 || RUNNER_ERRORS[k].httpStatus === 403));

/** Outcome counts for a set of run requests. */
export interface RunOutcomeCounts {
  requests: number;
  started: number;
  failed: number;
  expired: number;
  refused: number;
  pending: number;
}

/** One bucket of the run-request series. `period` is a local wall-clock bucket start. */
export interface RunRequestTrendPoint extends RunOutcomeCounts {
  period: string;
}

/** A failure code and how often it ended a request in the window. */
export interface RunnerFailureCode {
  /** A RUNNER_ERRORS code, or `OTHER` for anything outside the catalog. */
  code: string;
  category: RunnerErrorCategory | 'other';
  count: number;
}

/** One runner's reliability over the window. */
export interface RunnerReliabilityRow extends RunOutcomeCounts {
  runnerId: string;
  /** Null for a runner owned outside the scope that is no longer shared (or no longer exists). */
  label: string | null;
  /** `own`: an org in the scope owns it; `shared`: inherited from a parent org. */
  ownership: 'own' | 'shared';
  health: RunnerHealth | null;
  status: RunnerStatus | null;
  /** Own runners only (a parent's runner does not expose it). */
  consecutiveFailures: number | null;
  lastDeliveryAt: string | null;
  /** (failed + expired + refused) / finished, in percent; null when nothing finished. */
  failureRatePct: number | null;
}

/** The runner reliability report. */
export interface RunnerReliabilityReport {
  window: { from: string; to: string };
  totals: RunOutcomeCounts & { failureRatePct: number | null };
  trend: RunRequestTrendPoint[];
  /** Request → started execution's start, over start requests with an ingested execution. */
  latency: { n: number; medianSeconds: number | null; p90Seconds: number | null };
  topFailureCodes: RunnerFailureCode[];
  runners: RunnerReliabilityRow[];
}

/** Deployments on one local day to one environment. */
export interface CalendarDay {
  /** `YYYY-MM-DD` in the report timezone. */
  day: string;
  environment: string;
  deployments: number;
  failed: number;
}

/** How a production deploy turned out. */
export type ProductionDeployOutcome = 'succeeded' | 'failed' | 'post_deploy_failure';

/** One production deploy in the range. */
export interface ProductionDeploy {
  executionId: string;
  pipelineId: string | null;
  pipelineName: string | null;
  environment: string;
  deployedAt: string;
  commitCount: number | null;
  outcome: ProductionDeployOutcome;
}

/** The deployment calendar and change volume report. */
export interface DeploymentCalendarReport {
  window: { from: string; to: string };
  /** The zone the days are counted in. */
  tz: string;
  /** Only days with a deployment; sorted by day, then environment. */
  days: CalendarDay[];
  environments: string[];
  totals: { deployments: number; failed: number; commits: number };
  /** Over deploys with a known commit count. */
  commitsPerDeploy: { n: number; median: number | null; p90: number | null };
  productionDeploys: { count: number; items: ProductionDeploy[] };
}

/** At most this many failure codes are listed. */
const FAILURE_CODE_LIMIT = 10;
/** At most this many production deploys are itemized (the count is exact). */
const PRODUCTION_LIST_LIMIT = 200;

const refusalList = sql.join(RUNNER_REFUSAL_CODES.map((c) => sql`${c}`), sql`, `);

/** The outcome of request row `r`, in SQL. */
const outcomeSql = sql`CASE
    WHEN r.status IN ('started', 'stopped') THEN 'started'
    WHEN r.status = 'expired' THEN 'expired'
    WHEN r.status = 'failed' AND r.error_code IN (${refusalList}) THEN 'refused'
    WHEN r.status = 'failed' THEN 'failed'
    ELSE 'pending'
  END`;

/** The outcome-count columns over `outcome`. */
const countCols = sql`COUNT(*)::int AS requests,
    COUNT(*) FILTER (WHERE outcome = 'started')::int AS started,
    COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed,
    COUNT(*) FILTER (WHERE outcome = 'expired')::int AS expired,
    COUNT(*) FILTER (WHERE outcome = 'refused')::int AS refused,
    COUNT(*) FILTER (WHERE outcome = 'pending')::int AS pending`;

function counts(r: Record<string, unknown> | undefined): RunOutcomeCounts {
  return {
    requests: num(r?.requests),
    started: num(r?.started),
    failed: num(r?.failed),
    expired: num(r?.expired),
    refused: num(r?.refused),
    pending: num(r?.pending),
  };
}

function failureRate(c: RunOutcomeCounts): number | null {
  const finished = c.requests - c.pending;
  if (finished <= 0) return null;
  return Math.round(((c.failed + c.expired + c.refused) / finished) * 1000) / 10;
}

const isoOrNull = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const roundOrNull = (v: unknown, digits = 0): number | null => {
  if (v === null || v === undefined) return null;
  const f = 10 ** digits;
  return Math.round(num(v) * f) / f;
};

/**
 * Run latency and runner reliability for a window.
 *
 * `bucket.interval` is validated against the report-interval allow-list (the
 * route validates it first); `tz` falls back to UTC when unusable.
 */
export async function getRunnerReliability(scope: DeliveryScope, bucket: DeliveryBucket): Promise<RunnerReliabilityReport> {
  assertReportInterval(bucket.interval);
  const tz = safeTz(bucket.tz);
  const weekStart = bucket.weekStart ?? 'monday';
  const { from, to } = scope;
  const { ids } = orgScope(scope.orgId, scope.orgIds);

  const scoped = await securityRead(scope, async (org, tx) => {
    const reqs = sql`
      SELECT r.runner_id, r.status, r.error_code, r.action, r.requested_at, r.result_execution_id, r.pipeline_id,
             ${outcomeSql} AS outcome
      FROM pipeline_run_requests r
      WHERE r.org_id ${org}
        AND r.action IN ('start', 'stop')
        AND r.requested_at >= ${from}::timestamptz AND r.requested_at < ${to}::timestamptz`;
    const [totRes, trendRes, latRes, codeRes, perRes] = [
      await tx.execute(sql`WITH q AS (${reqs}) SELECT ${countCols} FROM q`),
      await tx.execute(sql`
        WITH q AS (${reqs}),
        b AS ${bucketSeries(bucket.interval, from, to, tz, weekStart)},
        c AS (
          SELECT ${periodBucket(bucket.interval, sql`requested_at`, tz, weekStart)}::text AS period, ${countCols}
          FROM q GROUP BY 1)
        SELECT b.period, COALESCE(c.requests, 0)::int AS requests, COALESCE(c.started, 0)::int AS started,
               COALESCE(c.failed, 0)::int AS failed, COALESCE(c.expired, 0)::int AS expired,
               COALESCE(c.refused, 0)::int AS refused, COALESCE(c.pending, 0)::int AS pending
        FROM b LEFT JOIN c ON c.period = b.period
        ORDER BY b.period`),
      await tx.execute(sql`
        WITH q AS (${reqs}),
        l AS (
          SELECT EXTRACT(EPOCH FROM (MIN(e.started_at) - q.requested_at)) AS s
          FROM q
          JOIN pipeline_events e
            ON e.execution_id = q.result_execution_id AND e.pipeline_id = q.pipeline_id AND e.org_id ${org}
          WHERE q.action = 'start' AND q.outcome = 'started' AND q.result_execution_id IS NOT NULL
            AND e.started_at IS NOT NULL
          GROUP BY q.requested_at, q.result_execution_id)
        SELECT COUNT(*)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(s, 0)) AS median_s,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY GREATEST(s, 0)) AS p90_s
        FROM l`),
      await tx.execute(sql`
        WITH q AS (${reqs})
        SELECT error_code, COUNT(*)::int AS c
        FROM q WHERE outcome IN ('failed', 'expired', 'refused')
        GROUP BY error_code`),
      await tx.execute(sql`
        WITH q AS (${reqs})
        SELECT runner_id::text AS runner_id, ${countCols}
        FROM q WHERE runner_id IS NOT NULL
        GROUP BY runner_id`),
    ];
    return {
      totals: counts(resultRows<Record<string, unknown>>(totRes)[0]),
      trend: resultRows<Record<string, unknown>>(trendRes).map((r) => ({ period: String(r.period), ...counts(r) })),
      latency: resultRows<Record<string, unknown>>(latRes)[0] ?? {},
      codes: resultRows<{ error_code: string | null; c: number }>(codeRes),
      perRunner: resultRows<Record<string, unknown>>(perRes),
    };
  });

  // Runner rows: a parent's shared runner is invisible under the team's RLS, so
  // this one read steps outside it — bounded to the runners the scope's own
  // requests went through and the scope's own runners, and selecting only the
  // columns a team's runner list shows (never function_url).
  const usedIds = scoped.perRunner.map((r) => String(r.runner_id));
  const meta = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTxRead(async (tx) => resultRows<Record<string, unknown>>(
    await tx.execute(sql`
      SELECT id::text AS id, org_id, label, share_with_teams, health, status, consecutive_failures, last_delivery_at
      FROM pipeline_runners
      WHERE id::text = ${anyText(usedIds)}
         OR (org_id = ${anyText(ids)} AND status <> 'revoked')`),
  )));

  const inScope = new Set(ids.map((i) => i.toLowerCase()));
  const metaById = new Map(meta.map((m) => [String(m.id), m]));
  const perById = new Map(scoped.perRunner.map((r) => [String(r.runner_id), counts(r)]));
  const allIds = new Set([...perById.keys(), ...meta.filter((m) => inScope.has(String(m.org_id).toLowerCase())).map((m) => String(m.id))]);

  const runners: RunnerReliabilityRow[] = [...allIds].map((id) => {
    const c = perById.get(id) ?? counts(undefined);
    const m = metaById.get(id);
    const own = !!m && inScope.has(String(m.org_id).toLowerCase());
    const visible = own || (!!m && m.share_with_teams === true);
    return {
      runnerId: id,
      label: visible ? String(m!.label) : null,
      ownership: own ? 'own' as const : 'shared' as const,
      health: visible ? (m!.health as RunnerHealth) : null,
      status: visible ? (m!.status as RunnerStatus) : null,
      consecutiveFailures: own ? num(m!.consecutive_failures) : null,
      lastDeliveryAt: visible ? isoOrNull(m!.last_delivery_at) : null,
      ...c,
      failureRatePct: failureRate(c),
    };
  }).sort((a, b) => b.requests - a.requests || (a.label ?? '￿').localeCompare(b.label ?? '￿') || a.runnerId.localeCompare(b.runnerId));

  const codeCounts = new Map<string, number>();
  for (const r of scoped.codes) {
    const code = r.error_code && isRunnerErrorCode(r.error_code) ? r.error_code : 'OTHER';
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + num(r.c));
  }
  const topFailureCodes: RunnerFailureCode[] = [...codeCounts.entries()]
    .map(([code, count]) => ({
      code,
      category: isRunnerErrorCode(code) ? RUNNER_ERRORS[code].category : 'other' as const,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, FAILURE_CODE_LIMIT);

  const n = num(scoped.latency.n);
  return {
    window: { from, to },
    totals: { ...scoped.totals, failureRatePct: failureRate(scoped.totals) },
    trend: scoped.trend,
    latency: { n, medianSeconds: n > 0 ? roundOrNull(scoped.latency.median_s) : null, p90Seconds: n > 0 ? roundOrNull(scoped.latency.p90_s) : null },
    topFailureCodes,
    runners,
  };
}

/**
 * The deployment calendar and change volume for a window, with days counted in
 * `opts.tz` (UTC when unusable).
 */
export async function getDeploymentCalendar(scope: DeliveryScope, opts: { tz?: string } = {}): Promise<DeploymentCalendarReport> {
  const tz = safeTz(opts.tz);
  const { from, to } = scope;
  return securityRead(scope, async (org, tx) => {
    const deploys = sql`
      SELECT d.* FROM dora_deployments d
      WHERE d.org_id ${org}
        AND d.deployed_at >= ${from}::timestamptz AND d.deployed_at < ${to}::timestamptz`;
    const [dayRes, totRes, prodRes] = [
      await tx.execute(sql`
        WITH q AS (${deploys})
        SELECT to_char((deployed_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, environment,
               COUNT(*)::int AS deployments, COUNT(*) FILTER (WHERE NOT succeeded)::int AS failed
        FROM q GROUP BY 1, 2 ORDER BY 1, 2`),
      await tx.execute(sql`
        WITH q AS (${deploys})
        SELECT COUNT(*)::int AS deployments,
               COUNT(*) FILTER (WHERE NOT succeeded)::int AS failed,
               COALESCE(SUM(commit_count), 0)::int AS commits,
               COUNT(commit_count)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY commit_count) AS median,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY commit_count) AS p90
        FROM q`),
      await tx.execute(sql`
        WITH q AS (${deploys})
        SELECT q.execution_id, q.pipeline_id, p.pipeline_name, q.environment, q.deployed_at, q.commit_count, q.succeeded,
               EXISTS (SELECT 1 FROM deployment_outcomes o
                       WHERE o.org_id = q.org_id AND o.execution_id = q.execution_id AND o.outcome = 'failed'
                         AND (o.environment IS NULL OR o.environment = q.environment)) AS marked_failed,
               COUNT(*) OVER ()::int AS total
        FROM q
        LEFT JOIN pipelines p ON p.id::text = q.pipeline_id AND p.org_id = q.org_id
        WHERE q.environment = ${HEADLINE_ENV}
        ORDER BY q.deployed_at DESC, q.execution_id
        LIMIT ${PRODUCTION_LIST_LIMIT}`),
    ];
    const days = resultRows<Record<string, unknown>>(dayRes).map((r) => ({
      day: String(r.day), environment: String(r.environment), deployments: num(r.deployments), failed: num(r.failed),
    }));
    const t = resultRows<Record<string, unknown>>(totRes)[0] ?? {};
    const prod = resultRows<Record<string, unknown>>(prodRes);
    const n = num(t.n);
    return {
      window: { from, to },
      tz,
      days,
      environments: [...new Set(days.map((d) => d.environment))].sort(),
      totals: { deployments: num(t.deployments), failed: num(t.failed), commits: num(t.commits) },
      commitsPerDeploy: { n, median: n > 0 ? roundOrNull(t.median, 1) : null, p90: n > 0 ? roundOrNull(t.p90, 1) : null },
      productionDeploys: {
        count: prod.length > 0 ? num(prod[0]!.total) : 0,
        items: prod.map((r) => ({
          executionId: String(r.execution_id),
          pipelineId: (r.pipeline_id as string | null) ?? null,
          pipelineName: (r.pipeline_name as string | null) ?? null,
          environment: String(r.environment),
          deployedAt: isoOrNull(r.deployed_at) ?? String(r.deployed_at),
          commitCount: r.commit_count === null || r.commit_count === undefined ? null : num(r.commit_count),
          outcome: r.succeeded === false ? 'failed' : r.marked_failed === true ? 'post_deploy_failure' : 'succeeded',
        })),
      },
    };
  });
}
