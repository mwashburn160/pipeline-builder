// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCacheService, createLogger, errorMessage, REPORT_INTERVALS, scrubAwsIdentifiers, scrubAwsIdentifiersFromString } from '@pipeline-builder/api-core';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { drizzleRows } from './crud-service.js';
import { schema } from '../database/drizzle-schema.js';
import { withTenantTx, runWithTenantContext } from '../database/tenancy.js';

const logger = createLogger('reporting-service');

/**
 * Defense-in-depth guard for the `DATE_TRUNC(${interval}, …)` bucket argument.
 * The route layer (`parseReportInterval`) is the security boundary and already
 * rejects unknown intervals; this assert makes an invalid value fail fast at the
 * service boundary with a clear error instead of surfacing a raw Postgres error
 * if a caller ever bypasses the route validation. Shares api-core's
 * REPORT_INTERVALS allow-list so the two can't drift.
 */
function assertReportInterval(interval: string): void {
  if (!(REPORT_INTERVALS as readonly string[]).includes(interval)) {
    throw new Error(`Invalid report interval: ${interval}. Expected one of: ${REPORT_INTERVALS.join(', ')}`);
  }
}

/**
 * Cache for reporting aggregations. Two tiers:
 * - Inventory queries (plugin summary/distribution/versions): 5 min TTL — changes on plugin CRUD
 * - Execution/build queries with date ranges: 2 min TTL — new events arrive continuously
 */
const inventoryCache = createCacheService('report:inv:', parseInt(process.env.CACHE_TTL_REPORT_INVENTORY || '300', 10));
const timeseriesCache = createCacheService('report:ts:', parseInt(process.env.CACHE_TTL_REPORT_TIMESERIES || '120', 10));

// ─── Types ──────────────────────────────────────────────

interface ExecutionCount {
  id: string;
  project: string;
  organization: string;
  pipelineName: string | null;
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  firstExecution: string | null;
  lastExecution: string | null;
}

interface TimeSeriesEntry {
  period: string;
  succeeded: number;
  failed: number;
  canceled: number;
  successPct: number;
}

interface DurationStats {
  id: string;
  project: string;
  pipelineName: string | null;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  executions: number;
}

interface PipelineExecution {
  executionId: string;
  /** Rolled-up terminal status: succeeded | failed | canceled | in-progress. */
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** First failing stage/action for the execution (null when it didn't fail). */
  failingStage: string | null;
  failingAction: string | null;
}

interface StageFailure {
  stageName: string;
  failures: number;
  total: number;
  failurePct: number;
}

interface StageBottleneck {
  id: string;
  pipelineName: string | null;
  stageName: string;
  avgMs: number;
  maxMs: number;
}

interface ActionFailure {
  actionName: string;
  failures: number;
  total: number;
  failurePct: number;
}

interface ErrorEntry {
  errorPattern: string;
  occurrences: number;
  affectedPipelines: number;
  lastSeen: string;
}

interface PluginSummary {
  total: number;
  active: number;
  inactive: number;
  public: number;
  private: number;
  uniqueNames: number;
}

interface TypeComputeDistribution {
  pluginType: string;
  computeType: string;
  count: number;
}

interface VersionCount {
  name: string;
  versionCount: number;
  latestVersion: string;
  hasDefault: boolean;
}

interface BuildTimeSeriesEntry {
  period: string;
  succeeded: number;
  failed: number;
  successPct: number;
}

interface BuildDuration {
  pluginName: string;
  avgMs: number;
  maxMs: number;
  builds: number;
}

interface BuildFailure {
  pluginName: string;
  errorMessage: string;
  occurrences: number;
  lastSeen: string;
}

/** Raw single-row shape returned by the DORA aggregate query (pre-shaping). */
/**
 * How far past the report's `to` bound the DORA MTTR query may look for a
 * failure's recovering run. Bounds the scan while stopping a failure near the
 * window edge from being spuriously scored "never restored". A failure that
 * has not recovered within this window stays counted as an open incident.
 */
const MTTR_RESTORE_LOOKAHEAD = '30 days';

/**
 * DORA performance band. `null` = insufficient data to classify (no
 * deployments/failures/lead-time sample in the window), so the UI shows a
 * neutral state rather than mislabeling an empty window as "low".
 */
export type DoraLevel = 'elite' | 'high' | 'medium' | 'low' | null;

/** Optional scoping for {@link ReportingService.getDoraMetrics}. */
export interface DoraOptions {
  /** Restrict to a single pipeline (per-pipeline DORA). */
  pipelineId?: string;
  /** Count only executions deployed to this environment (deploy-scoped). */
  environment?: string;
  /** Count only executions tagged with ANY environment (real deployments). */
  deploysOnly?: boolean;
}

// DORA performance bands (thresholds from the DORA/Accelerate reports). Each
// helper returns `null` when there's no sample to classify.
/** Deployment frequency by deploys/day: elite ≥1/day, high ≥1/week, medium ≥1/month. */
function doraLevelForFrequency(perDay: number, deployments: number): DoraLevel {
  if (deployments <= 0) return null;
  if (perDay >= 1) return 'elite';
  if (perDay >= 1 / 7) return 'high';
  if (perDay >= 1 / 30) return 'medium';
  return 'low';
}
/** Change failure rate by percent: elite ≤5%, high ≤10%, medium ≤15%. */
function doraLevelForChangeFailure(pct: number, total: number): DoraLevel {
  if (total <= 0) return null;
  if (pct <= 5) return 'elite';
  if (pct <= 10) return 'high';
  if (pct <= 15) return 'medium';
  return 'low';
}
/** Time to restore by seconds: elite <1h, high <1 day, medium <1 week. */
function doraLevelForRestore(avgSeconds: number | null): DoraLevel {
  if (avgSeconds == null) return null;
  if (avgSeconds < 3600) return 'elite';
  if (avgSeconds < 86400) return 'high';
  if (avgSeconds < 604800) return 'medium';
  return 'low';
}
/** Lead time by seconds: elite <1 day, high <1 week, medium <1 month. */
function doraLevelForLeadTime(medianSeconds: number | null): DoraLevel {
  if (medianSeconds == null) return null;
  if (medianSeconds < 86400) return 'elite';
  if (medianSeconds < 604800) return 'high';
  if (medianSeconds < 2592000) return 'medium';
  return 'low';
}

/**
 * Round `value` to `digits` decimal places, returning a real number. Small
 * module-private helper so the DORA shaping doesn't repeat the
 * `Number(Number(x).toFixed(n))` pattern (toFixed alone yields a string).
 */
function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/**
 * Shared per-execution terminal-status roll-up for the DORA `execs` CTEs:
 * FAILED wins, then SUCCEEDED, else CANCELED/STOPPED. Kept in one place so
 * getDoraMetrics and getDoraTrend can't drift on the precedence.
 */
const DORA_TERMINAL_STATUS_CASE = sql`
            CASE
              WHEN bool_or(e.status = 'FAILED') THEN 'FAILED'
              WHEN bool_or(e.status = 'SUCCEEDED') THEN 'SUCCEEDED'
              ELSE 'CANCELED'
            END`;

/**
 * Optional per-pipeline / deploy-scoping predicates + the resulting `basis`,
 * shared by getDoraMetrics and getDoraTrend so the env/deploysOnly precedence
 * can't diverge. `environment` (one target) wins over `deploysOnly` (any env).
 */
function doraScopeClauses(opts: DoraOptions) {
  const { pipelineId, environment, deploysOnly } = opts;
  const pipelineClause = pipelineId ? sql`AND e.pipeline_id = ${pipelineId}` : sql``;
  const deployClause = environment
    ? sql`AND e.environment = ${environment}`
    : deploysOnly ? sql`AND e.environment IS NOT NULL` : sql``;
  const basis: 'deploy' | 'run' = environment || deploysOnly ? 'deploy' : 'run';
  return { pipelineClause, deployClause, basis };
}

/**
 * Shared `execs` CTE body — the per-execution terminal roll-up that BOTH DORA
 * methods scan. Only the SELECTed columns and the upper range bound differ
 * (getDoraMetrics needs pipeline_id/ended_at/duration_ms plus a look-ahead tail
 * for MTTR recovery; getDoraTrend needs only started_at over the core window),
 * so those are the parameters. The `event_type='PIPELINE'` gate, the
 * SUCCEEDED/FAILED/CANCELED/STOPPED status set, the `execution_id` filter, the
 * org + deploy/pipeline scope clauses, and the `GROUP BY` all live here so the
 * two callers can't drift on the status set or the predicate.
 *
 * @param columns  trailing SELECT columns (after `e.execution_id,`)
 * @param toBound  the `<=` upper-bound expression on `e.started_at`
 *                 (core window for the trend; core + look-ahead for metrics)
 */
function execsCte(args: {
  pred: SQL;
  columns: SQL;
  pipelineClause: SQL;
  deployClause: SQL;
  from: string;
  toBound: SQL;
}): SQL {
  const { pred, columns, pipelineClause, deployClause, from, toBound } = args;
  return sql`
        SELECT
          e.execution_id,
          ${columns}
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'PIPELINE'
          -- STOPPED (manually aborted) joins CANCELED in the ELSE bucket; both
          -- are terminal non-deploy outcomes. SUPERSEDED stays excluded (a
          -- replaced execution, not an outcome).
          AND e.status IN ('SUCCEEDED', 'FAILED', 'CANCELED', 'STOPPED')
          AND e.execution_id IS NOT NULL
          ${pipelineClause}
          ${deployClause}
          AND e.started_at >= ${from}::timestamptz
          AND e.started_at <= ${toBound}
        GROUP BY e.execution_id, e.pipeline_id`;
}

interface DoraRow {
  df_deployments?: number | string | null;
  cfr_failed?: number | string | null;
  cfr_total?: number | string | null;
  lt_deployments?: number | string | null;
  lt_median_ms?: number | string | null;
  mttr_failures?: number | string | null;
  mttr_restored?: number | string | null;
  mttr_avg_seconds?: number | string | null;
}

/**
 * DORA metrics over a [from,to] window, org-scoped (single-org or rollup subtree).
 *
 * A "deployment" is a TERMINAL pipeline-level event, rolled up to one row per
 * `execution_id` (FAILED wins, then SUCCEEDED, then CANCELED/STOPPED — same
 * precedence as `listPipelineExecutions`).
 *
 * DISCLOSURE — these are RUN-BASED approximations of DORA. A "deployment" here
 * is any successful pipeline RUN, not a verified production deployment: the
 * event stream carries no deploy-stage/environment marker, so a CI-only
 * build/test pipeline counts the same as one that ships to prod. That makes
 * `deploymentFrequency` a pipeline-throughput signal and `changeFailureRate` a
 * pipeline-failure rate (build/test failures caught in CI count too), and MTTR
 * a pipeline-recovery time. Only `leadTime` carries an explicit `approx` flag
 * (it is additionally a run-time proxy), but ALL four share the run≠deploy
 * caveat until deploy/commit metadata is captured. See docs/dora-metrics.md.
 */
export interface DoraMetrics {
  /** The [from,to] window echoed back (started_at range). */
  window: { from: string; to: string };
  /**
   * Whether the numbers count real deployments or pipeline runs:
   * - `'deploy'` — scoped to executions tagged with a deploy `environment`
   *   (via `environment`/`deploysOnly`); a genuine deployment signal.
   * - `'run'` — default: every successful PIPELINE run counts (no deploy
   *   marker applied). DF/CFR/MTTR then reflect pipeline activity, not deploys.
   */
  basis: 'deploy' | 'run';
  /** The scoping applied (echoed for the UI); `null` when unscoped. */
  filters: { pipelineId: string | null; environment: string | null };
  /** Deployment Frequency — SUCCEEDED terminal deployments in the window. */
  deploymentFrequency: {
    /** Count of successful deployments. */
    deployments: number;
    /** Successful deployments per day over the window. */
    perDay: number;
    /** Performance band, or null when there were no deployments. */
    level: DoraLevel;
  };
  /** Change Failure Rate — failed / (succeeded + failed); CANCELED excluded. */
  changeFailureRate: {
    failed: number;
    /** succeeded + failed (the CFR denominator). */
    total: number;
    /** failed/total as a percentage, 0–100, 1 decimal. */
    pct: number;
    /** Performance band, or null when there were no deployments to judge. */
    level: DoraLevel;
  };
  /** Mean Time To Restore — avg gap from a failure INCIDENT to its recovery.
   *  Consecutive failed runs of a pipeline (with no green run between) collapse
   *  into one incident; the gap is measured from the first failure's END to the
   *  recovering run's END. The recovery is visible up to a look-ahead past `to`
   *  so a failure near the window edge isn't spuriously counted unrestored. */
  meanTimeToRestore: {
    /** Failure incidents in the window (maximal runs of consecutive failures). */
    failures: number;
    /** Incidents that were followed by a succeeded run (recovered). */
    restored: number;
    /** Average restore gap in seconds; null when there were no incidents. */
    avgSeconds: number | null;
    /** Performance band, or null when there were no incidents. */
    level: DoraLevel;
  };
  /** Lead Time — PROXY: median pipeline RUN TIME of succeeded deployments.
   *  NOT true commit→prod lead time (executions don't capture commit time),
   *  hence `approx: true` so the UI/docs can label it. */
  leadTime: {
    /** Succeeded deployments with a duration (the median sample). */
    deployments: number;
    /** Median run time in seconds; null when no successful deployments. */
    medianSeconds: number | null;
    approx: true;
    /** Performance band, or null when there were no successful deployments. */
    level: DoraLevel;
  };
}

/** One interval bucket of the DORA trend (deployment frequency + change failure). */
export interface DoraTrendPoint {
  /** Bucket start (DATE_TRUNC of started_at), ISO text. */
  period: string;
  /** Successful deployments in the bucket. */
  deployments: number;
  /** Failed deployments in the bucket. */
  failed: number;
  /** succeeded + failed in the bucket. */
  total: number;
  /** failed/total as a percent (0 when total is 0). */
  changeFailurePct: number;
}

/** Event payload accepted by `ReportingService.ingestEvents`. Mirrors the route's Zod shape. */
export interface IngestEvent {
  /** Stable pipeline id the events Lambda read from the `PIPELINE_EVENT_ID`
   *  tag (= the platform pipelineId). The registry join key. */
  pipelineId: string;
  eventSource: 'codepipeline' | 'codebuild' | 'plugin-build';
  eventType: 'PIPELINE' | 'STAGE' | 'ACTION' | 'BUILD';
  status: string;
  executionId?: string;
  stageName?: string;
  actionName?: string;
  /** Human-readable failure reason (Action events). */
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Source commit id of the change being shipped (DORA deploy attribution). */
  commitSha?: string;
  /** Source ref/branch (DORA deploy attribution). */
  commitRef?: string;
  /** Deploy target (e.g. "production"). Its presence marks a real deployment. */
  environment?: string;
  detail?: Record<string, unknown>;
}

/** Counts + the (possibly truncated) list of unregistered pipeline ids the caller can log. */
export interface IngestResult {
  inserted: number;
  skipped: number;
  unregisteredPipelineIds: string[];
}

// ─── Service ────────────────────────────────────────────

/**
 * Read-only reporting service for pipeline execution and plugin inventory aggregations.
 * Does not extend CrudService — reports are aggregate queries, not entity CRUD.
 *
 * All queries are cached in-memory to avoid repeated expensive SQL aggregations:
 * - Inventory queries (plugin summary/distribution/versions): 5 min TTL
 * - Timeseries queries (execution/build metrics with date ranges): 2 min TTL
 */
export class ReportingService {

  /** Invalidate all cached reports for an org (call after event ingest). */
  async invalidateOrg(orgId: string): Promise<void> {
    await Promise.all([
      inventoryCache.invalidatePattern(`${orgId}:*`),
      timeseriesCache.invalidatePattern(`${orgId}:*`),
    ]);
  }

  /**
   * Resolve incoming events against the pipeline registry, batch-insert the
   * matched ones, and invalidate reporting caches for affected orgs.
   * Events for unregistered pipeline ids are dropped (and logged at WARN
   * with sample ids so an operator can see when EventBridge is delivering
   * events for pipelines that haven't called POST /pipelines/registry yet).
   *
   * Returns counts + a sample of unregistered pipeline ids for observability.
   */
  async ingestEvents(events: IngestEvent[]): Promise<IngestResult> {
    // Multi-org batch insert: the caller resolves to multiple orgs via the
    // pipeline-registry lookup below, so the route layer MUST establish a
    // `runWithTenantContext({ isSuperAdmin: true }, ...)` scope before calling
    // this method. Under FORCE'd RLS, a single tx with `app.org_id = <one
    // org>` could only write events for that org; bypass via sysadmin is
    // the right gate for this server-internal cross-tenant endpoint. See
    // api/reporting/src/routes/event-ingest.ts for the wrapper.
    // Run insert inside the tx, but COLLECT affected orgs and invalidate
    // caches AFTER the tx resolves. Keeping invalidation inside the tx held
    // the pg locks open for the duration of the cache round-trips (Redis or
    // in-memory invalidations are unrelated to the tx but still serialized
    // its commit). Cache TTL is 2-5 min so fire-and-forget post-commit is
    // an acceptable trade for tighter lock windows.
    const { inserted, skipped, unregisteredPipelineIds, affectedOrgs } = await withTenantTx(async (tx) => {
      // Batch-resolve all unique pipeline ids in one query
      const uniqueIds = [...new Set(events.map(e => e.pipelineId))];
      const registryRows = await tx
        .select({
          pipelineId: schema.pipelineRegistry.pipelineId,
          orgId: schema.pipelineRegistry.orgId,
        })
        .from(schema.pipelineRegistry)
        .where(inArray(schema.pipelineRegistry.pipelineId, uniqueIds));

      const idMap = new Map(registryRows.map(r => [r.pipelineId, r]));

      // Build insert batch (skip events whose pipeline isn't registered)
      const rows: Array<typeof schema.pipelineEvent.$inferInsert> = [];
      let skippedLocal = 0;
      const unregisteredLocal: string[] = [];

      for (const event of events) {
        const registry = idMap.get(event.pipelineId);
        if (!registry) {
          skippedLocal++;
          unregisteredLocal.push(event.pipelineId);
          continue;
        }

        rows.push({
          // registry.pipelineId === event.pipelineId; use the registry's so the
          // FK is always a row that exists, and pull orgId from the registry for
          // tenancy (never trust the caller's claimed org).
          pipelineId: registry.pipelineId,
          orgId: registry.orgId,
          eventSource: event.eventSource,
          eventType: event.eventType,
          status: event.status,
          executionId: event.executionId,
          stageName: event.stageName,
          actionName: event.actionName,
          // HARD CONSTRAINT: an AWS account id must NEVER be persisted. This is
          // the DURABLE persistence boundary and must not trust upstream:
          // CodePipeline/CodeBuild failure detail & messages routinely carry
          // ARNs (arn:aws:…:<account-id>:…) and bare 12-digit account ids. Scrub
          // both free-form fields here before insert (per-event, non-mutating).
          errorMessage: event.errorMessage !== undefined
            ? scrubAwsIdentifiersFromString(event.errorMessage)
            : undefined,
          startedAt: event.startedAt ? new Date(event.startedAt) : undefined,
          completedAt: event.completedAt ? new Date(event.completedAt) : undefined,
          durationMs: event.durationMs,
          // Deploy-attribution fields — scrubbed like the other free-form strings
          // so an ARN/account id can never enter via a ref or environment name.
          commitSha: event.commitSha !== undefined
            ? scrubAwsIdentifiersFromString(event.commitSha)
            : undefined,
          commitRef: event.commitRef !== undefined
            ? scrubAwsIdentifiersFromString(event.commitRef)
            : undefined,
          environment: event.environment !== undefined
            ? scrubAwsIdentifiersFromString(event.environment)
            : undefined,
          detail: event.detail !== undefined
            ? scrubAwsIdentifiers(event.detail)
            : undefined,
        });
      }

      // SQS is at-least-once, so EventBridge can deliver the same state-change
      // twice. `onConflictDoNothing` + the partial unique index on
      // (pipeline_id, execution_id, event_type, status, stage_name, action_name)
      // makes re-delivery idempotent. `returning` gives the REAL inserted set so
      // counts + cache invalidation ignore duplicates.
      const insertedRows = rows.length > 0
        ? await tx.insert(schema.pipelineEvent).values(rows)
          .onConflictDoNothing()
          .returning({ orgId: schema.pipelineEvent.orgId })
        : [];

      return {
        inserted: insertedRows.length,
        skipped: skippedLocal,
        unregisteredPipelineIds: unregisteredLocal,
        affectedOrgs: [...new Set(insertedRows.map(r => r.orgId))],
      };
    });

    // Surface the silent skip: an unregistered pipeline id usually means the
    // pipeline hasn't called POST /pipelines/registry yet (or its
    // PIPELINE_EVENT_ID tag is missing/unreadable by the Lambda). Logging it
    // makes a broken join visible instead of looking like "no activity".
    if (unregisteredPipelineIds.length > 0) {
      logger.warn('Pipeline events skipped: pipeline id not found in registry', {
        count: unregisteredPipelineIds.length,
        sample: unregisteredPipelineIds.slice(0, 3),
      });
    }

    // Post-commit cache invalidation. Fire-and-forget with logging — TTL is
    // short enough that a missed invalidation self-heals.
    if (affectedOrgs.length > 0) {
      void Promise.all(affectedOrgs.map((org) =>
        this.invalidateOrg(org).catch((err) => {
          logger.warn('Reporting cache invalidation failed', { orgId: org, error: errorMessage(err) });
        }),
      ));
    }

    return { inserted, skipped, unregisteredPipelineIds };
  }

  // ── Category 1: Pipeline Execution & Performance ──

  /**
   * Build the org-scope predicate for a report query. With `orgIds` (the
   * org → team rollup — a parent's `[self, ...descendants]`) it becomes an
   * `IN (...)` over the subtree; otherwise the single-org `= $org`. Returns a
   * `multi` flag so callers can run multi-org reads under sysadmin context
   * (the subtree spans orgs outside the request's RLS scope) and salt the
   * cache key.
   */
  private orgScope(orgId: string, orgIds?: string[]) {
    const ids = orgIds && orgIds.length > 0 ? orgIds : [orgId];
    const multi = ids.length > 1;
    const pred = multi
      ? sql`IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
      : sql`= ${ids[0]}`;
    return { pred, multi };
  }

  /**
   * Run a report read. Single-org reads use the per-org cache (invalidated on
   * that org's event ingest). Rollup (multi-org) reads **bypass the cache** and
   * run under sysadmin context: they're admin-only and lower-frequency, and a
   * child org's event ingest can't invalidate a parent's rollup entry (reporting
   * has no org tree), so caching them would serve stale aggregates. Always fresh.
   */
  private runReport<T>(cacheKey: string, multi: boolean, exec: () => Promise<T>): Promise<T> {
    return multi
      ? runWithTenantContext({ isSuperAdmin: true }, exec)
      : timeseriesCache.getOrSet(cacheKey, exec);
  }

  /** 1.1 Execution count per pipeline with status breakdown. */
  async getExecutionCount(orgId: string, orgIds?: string[], range?: { from?: string; to?: string }): Promise<ExecutionCount[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    // Optional [from,to] window on the execution's started_at, mirroring the
    // sibling timeseries reports so the dashboard date-range picker narrows the
    // count too (an empty range = all-time, preserving the prior behavior). The
    // range rides the JOIN so pipelines with no in-window events still list
    // (LEFT semantics preserved via the inner-join filter — a pipeline with zero
    // matching events drops from the count, same as before for its window).
    const rangeClause = range?.from && range?.to
      ? sql`AND e.started_at >= ${range.from}::timestamptz AND e.started_at <= ${range.to}::timestamptz`
      : sql``;
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          p.id, p.project, p.organization, p.pipeline_name,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE e.status = 'CANCELED')::int AS canceled,
          MIN(e.started_at)::text AS first_execution,
          MAX(e.started_at)::text AS last_execution
        FROM ${schema.pipeline} p
        JOIN ${schema.pipelineEvent} e ON e.pipeline_id = p.id
          AND e.event_type = 'PIPELINE' AND e.status != 'STARTED'
          ${rangeClause}
        WHERE p.org_id ${pred} AND p.is_active = true
        GROUP BY p.id
        ORDER BY total DESC
      `).then(r => drizzleRows<ExecutionCount>(r.rows)));
    return this.runReport(`${orgId}:exec-count:${range?.from ?? ''}:${range?.to ?? ''}`, multi, exec);
  }

  /**
   * 1.1b Per-pipeline execution history — DISTINCT executions for one pipeline,
   * newest first. Groups all events by `execution_id` in a single scan and
   * rolls each execution up to one row:
   *   - status: derived from the PIPELINE-type events. FAILED wins, then
   *     SUCCEEDED, then CANCELED; an execution with no terminal PIPELINE event
   *     is still `in-progress`.
   *   - startedAt/endedAt/durationMs: from the PIPELINE lifecycle events.
   *   - failingStage/failingAction: the first FAILED STAGE/ACTION event (cheap —
   *     same scan, no extra query).
   *
   * ORG-SCOPING: identical to the sibling execution reports — joins the pipeline
   * registry table (`pipeline`) and gates on `p.org_id ${pred}`, where `pred` is
   * the single-org `= $org` or (with a rollup) an `IN (...)` over the org→team
   * subtree. A pipelineId belonging to another org yields zero rows.
   */
  async listPipelineExecutions(
    orgId: string,
    pipelineId: string,
    orgIds?: string[],
    range?: { from?: string; to?: string },
    limit: number = 50,
  ): Promise<PipelineExecution[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const rangeClause = range?.from && range?.to
      ? sql`AND e.started_at >= ${range.from}::timestamptz AND e.started_at <= ${range.to}::timestamptz`
      : sql``;
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.execution_id,
          CASE
            WHEN bool_or(e.event_type = 'PIPELINE' AND e.status = 'FAILED') THEN 'failed'
            WHEN bool_or(e.event_type = 'PIPELINE' AND e.status = 'SUCCEEDED') THEN 'succeeded'
            WHEN bool_or(e.event_type = 'PIPELINE' AND e.status = 'CANCELED') THEN 'canceled'
            ELSE 'in-progress'
          END AS status,
          MIN(e.started_at) FILTER (WHERE e.event_type = 'PIPELINE')::text AS started_at,
          MAX(e.completed_at) FILTER (WHERE e.event_type = 'PIPELINE')::text AS ended_at,
          MAX(e.duration_ms) FILTER (WHERE e.event_type = 'PIPELINE')::int AS duration_ms,
          (ARRAY_AGG(e.stage_name) FILTER (WHERE e.event_type = 'STAGE' AND e.status = 'FAILED'))[1] AS failing_stage,
          (ARRAY_AGG(e.action_name) FILTER (WHERE e.event_type = 'ACTION' AND e.status = 'FAILED'))[1] AS failing_action
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.pipeline_id = ${pipelineId} AND e.execution_id IS NOT NULL
          ${rangeClause}
        GROUP BY e.execution_id
        ORDER BY MAX(e.created_at) DESC
        LIMIT ${limit}
      `).then(r => drizzleRows<PipelineExecution>(r.rows)));
    return this.runReport(`${orgId}:pipeline-executions:${pipelineId}:${range?.from ?? ''}:${range?.to ?? ''}:${limit}`, multi, exec);
  }

  /** 1.2 Success rate over time for an org. */
  async getSuccessRate(orgId: string, interval: string, from: string, to: string, orgIds?: string[]): Promise<TimeSeriesEntry[]> {
    assertReportInterval(interval);
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          DATE_TRUNC(${interval}, e.started_at)::text AS period,
          COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE e.status = 'CANCELED')::int AS canceled,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS success_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'PIPELINE'
          AND e.status IN ('SUCCEEDED', 'FAILED', 'CANCELED')
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY period ORDER BY period
      `).then(r => drizzleRows<TimeSeriesEntry>(r.rows)));
    return this.runReport(`${orgId}:success-rate:${interval}:${from}:${to}`, multi, exec);
  }

  /** 1.3 Average duration per pipeline. */
  async getAverageDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<DurationStats[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          p.id, p.project, p.pipeline_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MIN(e.duration_ms)::int AS min_ms,
          MAX(e.duration_ms)::int AS max_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.duration_ms)::int AS p95_ms,
          COUNT(*)::int AS executions
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'PIPELINE' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY p.id ORDER BY avg_ms DESC
      `).then(r => drizzleRows<DurationStats>(r.rows)));
    return this.runReport(`${orgId}:avg-duration:${from}:${to}`, multi, exec);
  }

  /** 1.5 Stage failure heatmap — which stages fail most. */
  async getStageFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<StageFailure[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.stage_name,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failures,
          COUNT(*)::int AS total,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'FAILED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS failure_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.stage_name IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY e.stage_name ORDER BY failures DESC
      `).then(r => drizzleRows<StageFailure>(r.rows)));
    return this.runReport(`${orgId}:stage-failures:${from}:${to}`, multi, exec);
  }

  /** 1.6 Stage bottlenecks — slowest stages per pipeline. */
  async getStageBottlenecks(orgId: string, from: string, to: string, orgIds?: string[]): Promise<StageBottleneck[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          p.id, p.pipeline_name, e.stage_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MAX(e.duration_ms)::int AS max_ms
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY p.id, e.stage_name ORDER BY avg_ms DESC
      `).then(r => drizzleRows<StageBottleneck>(r.rows)));
    return this.runReport(`${orgId}:stage-bottlenecks:${from}:${to}`, multi, exec);
  }

  /** 1.7 Action failure rate — which plugin steps fail most. */
  async getActionFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<ActionFailure[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.action_name,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failures,
          COUNT(*)::int AS total,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'FAILED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS failure_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'ACTION' AND e.action_name IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY e.action_name ORDER BY failures DESC
      `).then(r => drizzleRows<ActionFailure>(r.rows)));
    return this.runReport(`${orgId}:action-failures:${from}:${to}`, multi, exec);
  }

  /**
   * 1.8 Error categorization — group failure messages. Execution report, so
   * rollup-aware exactly like the sibling execution reports: with `orgIds`
   * (the org→team subtree) the org gate becomes an `IN (...)` and the read runs
   * fresh under sysadmin via `runReport`; single-org reads keep the per-org cache.
   */
  async getErrors(orgId: string, from: string, to: string, limit: number = 20, orgIds?: string[]): Promise<ErrorEntry[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          SUBSTRING(e.error_message FROM 1 FOR 200) AS error_pattern,
          COUNT(*)::int AS occurrences,
          COUNT(DISTINCT e.pipeline_id)::int AS affected_pipelines,
          MAX(e.started_at)::text AS last_seen
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.status = 'FAILED' AND e.error_message IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY error_pattern ORDER BY occurrences DESC
        LIMIT ${limit}
      `).then(r => drizzleRows<ErrorEntry>(r.rows)));
    return this.runReport(`${orgId}:errors:${from}:${to}:${limit}`, multi, exec);
  }

  /**
   * 1.9 DORA metrics over [from,to] (started_at range), org-scoped + rollup-aware.
   *
   * All four metrics derive from a per-execution roll-up of TERMINAL PIPELINE
   * events (one row per execution_id+pipeline_id; FAILED wins, then SUCCEEDED,
   * then CANCELED/STOPPED — mirroring `listPipelineExecutions`). The scan is
   * gated by the `p.org_id ${pred}` join exactly like the sibling reports, so a
   * rollup passes the org→team subtree and a foreign org's executions never
   * enter the aggregate.
   *
   * DF/CFR/lead-time count only CORE-window executions ([from,to]). MTTR is
   * per-INCIDENT: consecutive failures collapse into one incident and the
   * recovery lookup may see the next success up to MTTR_RESTORE_LOOKAHEAD past
   * `to`, so a failure near the edge isn't right-censored into "never restored".
   * The scan bound is therefore `[from, to + look-ahead]`; the started_at range
   * still rides the same index as the sibling reports.
   *
   * DISCLOSURE: by default DF/CFR/MTTR are RUN-based (any successful PIPELINE
   * run = a "deployment"), and Lead Time is additionally a run-time PROXY
   * flagged `approx: true`. Pass `environment` or `deploysOnly` to scope to
   * executions tagged with a real deploy target — the response `basis` reports
   * which was used. See the DoraMetrics doc + docs/dora-metrics.md.
   *
   * @param opts.pipelineId    restrict to one pipeline (per-pipeline DORA)
   * @param opts.environment   count only executions deployed to this target
   * @param opts.deploysOnly   count only executions tagged with ANY environment
   */
  async getDoraMetrics(
    orgId: string,
    from: string,
    to: string,
    orgIds?: string[],
    opts: DoraOptions = {},
  ): Promise<DoraMetrics> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const { pipelineId, environment, deploysOnly } = opts;
    // Optional deploy-scoping / per-pipeline predicates, folded into the execs
    // scan so failures AND their recovery successes are filtered consistently.
    const { pipelineClause, deployClause, basis } = doraScopeClauses(opts);
    // Scan the CORE window plus a look-ahead tail: the extra tail exists only
    // so a late failure can still find its recovery (see the restore CTE).
    const execs = execsCte({
      pred,
      pipelineClause,
      deployClause,
      from,
      columns: sql`
            e.pipeline_id,
            ${DORA_TERMINAL_STATUS_CASE} AS status,
            MIN(e.started_at) AS started_at,
            MAX(e.completed_at) AS ended_at,
            MAX(e.duration_ms) AS duration_ms`,
      toBound: sql`${to}::timestamptz + ${MTTR_RESTORE_LOOKAHEAD}::interval`,
    });
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        WITH execs AS (${execs}
        ),
        -- Core-window executions ([from,to]); DF/CFR/lead-time count only these.
        -- The look-ahead rows above are used ONLY as MTTR recovery candidates.
        core AS (
          SELECT * FROM execs WHERE started_at <= ${to}::timestamptz
        ),
        df AS (
          SELECT COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS deployments
          FROM core
        ),
        cfr AS (
          SELECT
            COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
            COUNT(*) FILTER (WHERE status IN ('SUCCEEDED', 'FAILED'))::int AS total
          FROM core
        ),
        lt AS (
          SELECT
            COUNT(*)::int AS deployments,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::float AS median_ms
          FROM core
          WHERE status = 'SUCCEEDED' AND duration_ms IS NOT NULL
        ),
        -- For each core-window failure, find the END of its recovering run: the
        -- next SUCCEEDED run of the same pipeline that ENDED after this failure
        -- ended (visible into the look-ahead tail). SELECT and MEASURE both key
        -- off ended_at so they stay consistent -- the incident gap is
        -- restored_at (success end) minus incident_started (first failure end),
        -- so picking the recovery by ended_at (not started_at) rules out the
        -- negative gap that a concurrent success which STARTED after the failure
        -- but ENDED before it would otherwise fold into AVG. Measuring from the
        -- failure's END (not start) also keeps the failed run's own duration out
        -- of restore time. Ordering by ended_at makes the incident collapse fall
        -- out naturally: a green run ending between two failures splits them.
        restore AS (
          SELECT
            f.pipeline_id,
            f.ended_at AS fail_ended,
            (SELECT s.ended_at FROM execs s
              WHERE s.pipeline_id = f.pipeline_id AND s.status = 'SUCCEEDED'
                AND s.ended_at > f.ended_at
              ORDER BY s.ended_at ASC LIMIT 1) AS restored_at
          FROM core f
          WHERE f.status = 'FAILED'
        ),
        -- Collapse to INCIDENTS: failures sharing the same recovery (i.e. with
        -- no green run between them) are one incident, starting at the first
        -- failure's end. Unrecovered failures share restored_at = NULL and form
        -- the single trailing open incident per pipeline.
        incidents AS (
          SELECT pipeline_id, restored_at, MIN(fail_ended) AS incident_started
          FROM restore
          GROUP BY pipeline_id, restored_at
        ),
        mttr AS (
          SELECT
            COUNT(*)::int AS failures,
            -- restored must equal the count of incidents that actually
            -- contribute to avg_seconds. Guard on incident_started too: a
            -- failure with a NULL completed_at yields a NULL incident_started
            -- that contributes NULL (not a real gap) to AVG, so it must not be
            -- counted as restored either -- otherwise restored could exceed
            -- the number of measured incidents.
            COUNT(*) FILTER (
              WHERE restored_at IS NOT NULL AND incident_started IS NOT NULL
            )::int AS restored,
            AVG(EXTRACT(EPOCH FROM (restored_at - incident_started)))
              FILTER (WHERE restored_at IS NOT NULL AND incident_started IS NOT NULL)::float AS avg_seconds
          FROM incidents
        )
        SELECT
          df.deployments AS df_deployments,
          cfr.failed AS cfr_failed,
          cfr.total AS cfr_total,
          lt.deployments AS lt_deployments,
          lt.median_ms AS lt_median_ms,
          mttr.failures AS mttr_failures,
          mttr.restored AS mttr_restored,
          mttr.avg_seconds AS mttr_avg_seconds
        FROM df, cfr, lt, mttr
      `).then(r => this.shapeDora(drizzleRows<DoraRow>(r.rows)[0], from, to, basis, { pipelineId, environment })));
    // `environment` WINS over `deploysOnly` in doraScopeClauses, so with an
    // environment set the deploysOnly flag never affects the SQL — append the
    // 'd' marker only when it genuinely changes the query (environment absent),
    // otherwise `{environment:'prod', deploysOnly:true}` would mint a redundant
    // cache entry identical to `{environment:'prod'}`.
    const deployMarker = !environment && deploysOnly ? 'd' : '';
    const key = `${orgId}:dora:${from}:${to}:${pipelineId ?? ''}:${environment ?? ''}:${deployMarker}`;
    return this.runReport(key, multi, exec);
  }

  /** Shape a single DORA aggregate row into the public {@link DoraMetrics}. */
  private shapeDora(
    row: DoraRow | undefined,
    from: string,
    to: string,
    basis: DoraMetrics['basis'],
    filters: { pipelineId?: string; environment?: string },
  ): DoraMetrics {
    // `FROM df, cfr, lt, mttr` always yields exactly one row (each CTE is a
    // single-row aggregate), but guard against an empty result defensively.
    const r: DoraRow = row ?? {};

    const deployments = Number(r.df_deployments) || 0;
    // Floor the divisor at one day: a window shorter than a day (incl. the
    // degenerate from==to) has no meaningful sub-day rate, so it's treated as a
    // single day rather than extrapolated or mislabeled as a raw count.
    // Floor at one day and guard against unparseable dates (Date.parse → NaN,
    // which would otherwise propagate through perDay). Falls back to a 1-day
    // window so a bad range yields the raw count as the rate, never NaN.
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86400000;
    const days = Number.isFinite(spanDays) ? Math.max(spanDays, 1) : 1;
    // Band on the UNROUNDED rate; round only for display. Rounding first would
    // mislabel exact weekly/monthly boundaries (e.g. 1 deploy / 30 days →
    // 0.0333 rounds to 0.03 < 1/30 → wrongly "low" instead of "medium").
    const rawPerDay = deployments / days;
    const perDay = round(rawPerDay, 2);

    const failed = Number(r.cfr_failed) || 0;
    const total = Number(r.cfr_total) || 0;
    const rawPct = total > 0 ? (failed / total) * 100 : 0;
    const pct = round(rawPct, 1);

    // Band restore/lead-time on the RAW (pre-round) seconds, the same "band on
    // the unrounded value" principle used for perDay/pct above; keep the rounded
    // values for the response fields. Immaterial at the hour/day thresholds, but
    // it makes the principle uniform across all four metrics.
    const failures = Number(r.mttr_failures) || 0;
    const restored = Number(r.mttr_restored) || 0;
    const rawAvgSeconds = failures > 0 && r.mttr_avg_seconds != null
      ? Number(r.mttr_avg_seconds)
      : null;
    const avgSeconds = rawAvgSeconds != null ? round(rawAvgSeconds, 1) : null;

    const ltDeployments = Number(r.lt_deployments) || 0;
    const rawMedianSeconds = r.lt_median_ms != null
      ? Number(r.lt_median_ms) / 1000
      : null;
    const medianSeconds = rawMedianSeconds != null ? round(rawMedianSeconds, 1) : null;

    return {
      window: { from, to },
      basis,
      filters: { pipelineId: filters.pipelineId ?? null, environment: filters.environment ?? null },
      deploymentFrequency: { deployments, perDay, level: doraLevelForFrequency(rawPerDay, deployments) },
      changeFailureRate: { failed, total, pct, level: doraLevelForChangeFailure(rawPct, total) },
      meanTimeToRestore: { failures, restored, avgSeconds, level: doraLevelForRestore(rawAvgSeconds) },
      leadTime: { deployments: ltDeployments, medianSeconds, approx: true, level: doraLevelForLeadTime(rawMedianSeconds) },
    };
  }

  /**
   * 1.9b DORA trend — deployment frequency + change-failure rate bucketed by
   * `interval` (day/week/month) for a sparkline. Per-execution rollup (one row
   * per execution, FAILED wins) bucketed on the execution's started_at. Shares
   * the `getDoraMetrics` scoping (org/rollup, pipelineId, deploy-scoping); MTTR
   * and lead time are intentionally omitted (too heavy to bucket meaningfully).
   */
  async getDoraTrend(
    orgId: string,
    interval: string,
    from: string,
    to: string,
    orgIds?: string[],
    opts: DoraOptions = {},
  ): Promise<DoraTrendPoint[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const { pipelineId, environment, deploysOnly } = opts;
    const { pipelineClause, deployClause } = doraScopeClauses(opts);
    // Same execs roll-up as getDoraMetrics (shared builder — status set +
    // predicate can't drift); the trend needs only started_at over the core
    // window (no MTTR look-ahead, no ended_at/duration columns).
    const execs = execsCte({
      pred,
      pipelineClause,
      deployClause,
      from,
      columns: sql`
            ${DORA_TERMINAL_STATUS_CASE} AS status,
            MIN(e.started_at) AS started_at`,
      toBound: sql`${to}::timestamptz`,
    });
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        WITH execs AS (${execs}
        )
        SELECT
          DATE_TRUNC(${interval}, started_at)::text AS period,
          COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS deployments,
          COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE status IN ('SUCCEEDED', 'FAILED'))::int AS total,
          -- quoted alias so the raw row key is exactly the DoraTrendPoint field
          COALESCE(ROUND(COUNT(*) FILTER (WHERE status = 'FAILED')::numeric
            / NULLIF(COUNT(*) FILTER (WHERE status IN ('SUCCEEDED', 'FAILED')), 0) * 100, 1), 0)::float AS "changeFailurePct"
        FROM execs
        GROUP BY period ORDER BY period
      `).then(r => drizzleRows<DoraTrendPoint>(r.rows)));
    // Omit the deploysOnly marker when environment is set: it wins in
    // doraScopeClauses, so the SQL (and thus the correct cache key) is identical
    // to the environment-only case. Only append 'd' when it changes the query.
    const deployMarker = !environment && deploysOnly ? 'd' : '';
    const key = `${orgId}:dora-trend:${interval}:${from}:${to}:${pipelineId ?? ''}:${environment ?? ''}:${deployMarker}`;
    return this.runReport(key, multi, exec);
  }

  // ── Category 2: Plugin Inventory & Builds ──

  /** 2.1 Plugin summary — counts and breakdowns.
   *  INTENTIONALLY SINGLE-ORG (no rollup): plugin inventory is an org-owned
   *  asset count, not an execution/build activity report, so a parent's view is
   *  its own plugins — teams manage their own inventory. Single `= $org` scope. */
  async getPluginSummary(orgId: string): Promise<PluginSummary> {
    return inventoryCache.getOrSet(`${orgId}:plugin-summary`, async () => {
      const rows = await withTenantTx((tx) => tx.execute(sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE ${schema.plugin.isActive})::int AS active,
          COUNT(*) FILTER (WHERE NOT ${schema.plugin.isActive})::int AS inactive,
          COUNT(*) FILTER (WHERE ${schema.plugin.accessModifier} = 'public')::int AS public,
          COUNT(*) FILTER (WHERE ${schema.plugin.accessModifier} = 'private')::int AS private,
          COUNT(DISTINCT ${schema.plugin.name})::int AS unique_names
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId}
      `));
      return (drizzleRows<PluginSummary>(rows.rows)[0] || { total: 0, active: 0, inactive: 0, public: 0, private: 0, uniqueNames: 0 });
    });
  }

  /** 2.2 Type & compute distribution.
   *  INTENTIONALLY SINGLE-ORG (no rollup): plugin inventory is per-org (see
   *  getPluginSummary). Single `= $org` scope. */
  async getPluginDistribution(orgId: string): Promise<TypeComputeDistribution[]> {
    return inventoryCache.getOrSet(`${orgId}:plugin-distribution`, () =>
      withTenantTx((tx) => tx.execute(sql`
        SELECT
          ${schema.plugin.pluginType} AS plugin_type,
          ${schema.plugin.computeType} AS compute_type,
          COUNT(*)::int AS count
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId} AND ${schema.plugin.isActive} = true
        GROUP BY ${schema.plugin.pluginType}, ${schema.plugin.computeType}
        ORDER BY count DESC
      `).then(r => drizzleRows<TypeComputeDistribution>(r.rows))),
    );
  }

  /** 2.3 Version counts per plugin name.
   *  INTENTIONALLY SINGLE-ORG (no rollup): plugin inventory is per-org (see
   *  getPluginSummary). Single `= $org` scope. */
  async getPluginVersions(orgId: string): Promise<VersionCount[]> {
    return inventoryCache.getOrSet(`${orgId}:plugin-versions`, () =>
      withTenantTx((tx) => tx.execute(sql`
        SELECT
          ${schema.plugin.name},
          COUNT(*)::int AS version_count,
          MAX(${schema.plugin.version}) AS latest_version,
          bool_or(${schema.plugin.isDefault}) AS has_default
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId} AND ${schema.plugin.isActive} = true
        GROUP BY ${schema.plugin.name}
        ORDER BY version_count DESC
      `).then(r => drizzleRows<VersionCount>(r.rows))),
    );
  }

  /**
   * 2.4 Build success rate over time.
   *
   * STATUS CASING NOTE: This query filters by `event_source = 'plugin-build'`
   * and uses lowercase status values (`'completed'`, `'failed'`), while
   * `getSuccessRate` (1.2) filters by `event_type = 'PIPELINE'` with
   * uppercase AWS-style statuses (`'SUCCEEDED'`, `'FAILED'`, `'CANCELED'`).
   * The casing drift is intentional and tracks the producer:
   *   - `plugin-build` events come from our own build pipeline (lowercase)
   *   - `PIPELINE` events come from AWS CodePipeline (uppercase)
   * The ingest Zod schema at api/reporting/src/routes/event-ingest.ts
   * SHOULD enum these per-eventSource so we catch drift at ingest rather
   * than silently producing zero rows here. See findings N71.
   */
  async getBuildSuccessRate(orgId: string, interval: string, from: string, to: string, orgIds?: string[]): Promise<BuildTimeSeriesEntry[]> {
    assertReportInterval(interval);
    // Build activity report — rollup-aware like the execution reports. These
    // rows are gated on the pipeline_event `org_id` directly (no pipeline join),
    // so `pred` applies to `e.org_id`.
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          DATE_TRUNC(${interval}, e.started_at)::text AS period,
          COUNT(*) FILTER (WHERE e.status = 'completed')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'failed')::int AS failed,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'completed')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS success_pct
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND e.event_source = 'plugin-build'
          AND e.status IN ('completed', 'failed')
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY period ORDER BY period
      `).then(r => drizzleRows<BuildTimeSeriesEntry>(r.rows)));
    return this.runReport(`${orgId}:build-success:${interval}:${from}:${to}`, multi, exec);
  }

  /** 2.5 Build duration per plugin. Build activity report — rollup-aware. */
  async getBuildDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<BuildDuration[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.detail->>'pluginName' AS plugin_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MAX(e.duration_ms)::int AS max_ms,
          COUNT(*)::int AS builds
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND e.event_source = 'plugin-build' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY plugin_name ORDER BY avg_ms DESC
      `).then(r => drizzleRows<BuildDuration>(r.rows)));
    return this.runReport(`${orgId}:build-duration:${from}:${to}`, multi, exec);
  }

  /** 2.6 Build failures — top error messages. Build activity report — rollup-aware. */
  async getBuildFailures(orgId: string, from: string, to: string, limit: number = 20, orgIds?: string[]): Promise<BuildFailure[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.detail->>'pluginName' AS plugin_name,
          e.error_message,
          COUNT(*)::int AS occurrences,
          MAX(e.started_at)::text AS last_seen
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND e.event_source = 'plugin-build' AND e.status = 'failed'
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY plugin_name, e.error_message
        ORDER BY occurrences DESC
        LIMIT ${limit}
      `).then(r => drizzleRows<BuildFailure>(r.rows)));
    return this.runReport(`${orgId}:build-failures:${from}:${to}:${limit}`, multi, exec);
  }
}

export const reportingService = new ReportingService();
