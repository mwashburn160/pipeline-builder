// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCacheService, createLogger, errorMessage } from '@pipeline-builder/api-core';
import { inArray, sql } from 'drizzle-orm';
import { drizzleRows } from './crud-service.js';
import { schema } from '../database/drizzle-schema.js';
import { withTenantTx, runWithTenantContext } from '../database/tenancy.js';

const logger = createLogger('reporting-service');

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
   * Events for unregistered pipeline ARNs are dropped (and logged at WARN
   * with sample ARNs so an operator can see when EventBridge is delivering
   * events for pipelines that haven't called POST /pipelines/registry yet).
   *
   * Returns counts + a sample of unregistered ARNs for observability.
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
          errorMessage: event.errorMessage,
          startedAt: event.startedAt ? new Date(event.startedAt) : undefined,
          completedAt: event.completedAt ? new Date(event.completedAt) : undefined,
          durationMs: event.durationMs,
          detail: event.detail,
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
  async getExecutionCount(orgId: string, orgIds?: string[]): Promise<ExecutionCount[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
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
        WHERE p.org_id ${pred} AND p.is_active = true
        GROUP BY p.id
        ORDER BY total DESC
      `).then(r => drizzleRows<ExecutionCount>(r.rows)));
    return this.runReport(`${orgId}:exec-count`, multi, exec);
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

  /** 1.8 Error categorization — group failure messages. */
  async getErrors(orgId: string, from: string, to: string, limit: number = 20): Promise<ErrorEntry[]> {
    return timeseriesCache.getOrSet(`${orgId}:errors:${from}:${to}:${limit}`, () =>
      withTenantTx((tx) => tx.execute(sql`
        SELECT
          SUBSTRING(e.error_message FROM 1 FOR 200) AS error_pattern,
          COUNT(*)::int AS occurrences,
          COUNT(DISTINCT e.pipeline_id)::int AS affected_pipelines,
          MAX(e.started_at)::text AS last_seen
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id = ${orgId} AND e.status = 'FAILED' AND e.error_message IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY error_pattern ORDER BY occurrences DESC
        LIMIT ${limit}
      `).then(r => drizzleRows<ErrorEntry>(r.rows))),
    );
  }

  // ── Category 2: Plugin Inventory & Builds ──

  /** 2.1 Plugin summary — counts and breakdowns. */
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

  /** 2.2 Type & compute distribution. */
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

  /** 2.3 Version counts per plugin name. */
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
  async getBuildSuccessRate(orgId: string, interval: string, from: string, to: string): Promise<BuildTimeSeriesEntry[]> {
    return timeseriesCache.getOrSet(`${orgId}:build-success:${interval}:${from}:${to}`, () =>
      withTenantTx((tx) => tx.execute(sql`
        SELECT
          DATE_TRUNC(${interval}, e.started_at)::text AS period,
          COUNT(*) FILTER (WHERE e.status = 'completed')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'failed')::int AS failed,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'completed')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS success_pct
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id = ${orgId} AND e.event_source = 'plugin-build'
          AND e.status IN ('completed', 'failed')
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY period ORDER BY period
      `).then(r => drizzleRows<BuildTimeSeriesEntry>(r.rows))),
    );
  }

  /** 2.5 Build duration per plugin. */
  async getBuildDuration(orgId: string, from: string, to: string): Promise<BuildDuration[]> {
    return timeseriesCache.getOrSet(`${orgId}:build-duration:${from}:${to}`, () =>
      withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.detail->>'pluginName' AS plugin_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MAX(e.duration_ms)::int AS max_ms,
          COUNT(*)::int AS builds
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id = ${orgId} AND e.event_source = 'plugin-build' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY plugin_name ORDER BY avg_ms DESC
      `).then(r => drizzleRows<BuildDuration>(r.rows))),
    );
  }

  /** 2.6 Build failures — top error messages. */
  async getBuildFailures(orgId: string, from: string, to: string, limit: number = 20): Promise<BuildFailure[]> {
    return timeseriesCache.getOrSet(`${orgId}:build-failures:${from}:${to}:${limit}`, () =>
      withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.detail->>'pluginName' AS plugin_name,
          e.error_message,
          COUNT(*)::int AS occurrences,
          MAX(e.started_at)::text AS last_seen
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id = ${orgId} AND e.event_source = 'plugin-build' AND e.status = 'failed'
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY plugin_name, e.error_message
        ORDER BY occurrences DESC
        LIMIT ${limit}
      `).then(r => drizzleRows<BuildFailure>(r.rows))),
    );
  }
}

export const reportingService = new ReportingService();
