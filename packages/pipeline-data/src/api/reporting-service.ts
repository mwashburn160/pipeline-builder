import { createCacheService } from '@mwashburn160/api-core';
import { sql } from 'drizzle-orm';
import { drizzleRows } from './crud-service';
import { schema } from '../database/drizzle-schema';
import { db } from '../database/postgres-connection';

/** Cast raw SQL result rows to a typed array. */
function sqlRows<T>(result: { rows: unknown[] }): T[] {
  return drizzleRows<T>(result.rows);
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

  // ── Category 1: Pipeline Execution & Performance ──

  /** 1.1 Execution count per pipeline with status breakdown. */
  async getExecutionCount(orgId: string): Promise<ExecutionCount[]> {
    return timeseriesCache.getOrSet(`${orgId}:exec-count`, () =>
      db.execute(sql`
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
        WHERE p.org_id = ${orgId} AND p.is_active = true
        GROUP BY p.id
        ORDER BY total DESC
      `).then(r => sqlRows<ExecutionCount>(r)),
    );
  }

  /** 1.2 Success rate over time for an org. */
  async getSuccessRate(orgId: string, interval: string, from: string, to: string): Promise<TimeSeriesEntry[]> {
    return timeseriesCache.getOrSet(`${orgId}:success-rate:${interval}:${from}:${to}`, () =>
      db.execute(sql`
        SELECT
          DATE_TRUNC(${interval}, e.started_at)::text AS period,
          COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE e.status = 'CANCELED')::int AS canceled,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS success_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id = ${orgId} AND e.event_type = 'PIPELINE'
          AND e.status IN ('SUCCEEDED', 'FAILED', 'CANCELED')
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY period ORDER BY period
      `).then(r => sqlRows<TimeSeriesEntry>(r)),
    );
  }

  /** 1.3 Average duration per pipeline. */
  async getAverageDuration(orgId: string, from: string, to: string): Promise<DurationStats[]> {
    return timeseriesCache.getOrSet(`${orgId}:avg-duration:${from}:${to}`, () =>
      db.execute(sql`
        SELECT
          p.id, p.project, p.pipeline_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MIN(e.duration_ms)::int AS min_ms,
          MAX(e.duration_ms)::int AS max_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.duration_ms)::int AS p95_ms,
          COUNT(*)::int AS executions
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id = ${orgId} AND e.event_type = 'PIPELINE' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY p.id ORDER BY avg_ms DESC
      `).then(r => sqlRows<DurationStats>(r)),
    );
  }

  /** 1.5 Stage failure heatmap — which stages fail most. */
  async getStageFailures(orgId: string, from: string, to: string): Promise<StageFailure[]> {
    return timeseriesCache.getOrSet(`${orgId}:stage-failures:${from}:${to}`, () =>
      db.execute(sql`
        SELECT
          e.stage_name,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failures,
          COUNT(*)::int AS total,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'FAILED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS failure_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id = ${orgId} AND e.event_type = 'STAGE' AND e.stage_name IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY e.stage_name ORDER BY failures DESC
      `).then(r => sqlRows<StageFailure>(r)),
    );
  }

  /** 1.6 Stage bottlenecks — slowest stages per pipeline. */
  async getStageBottlenecks(orgId: string, from: string, to: string): Promise<StageBottleneck[]> {
    return timeseriesCache.getOrSet(`${orgId}:stage-bottlenecks:${from}:${to}`, () =>
      db.execute(sql`
        SELECT
          p.id, p.pipeline_name, e.stage_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MAX(e.duration_ms)::int AS max_ms
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id = ${orgId} AND e.event_type = 'STAGE' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY p.id, e.stage_name ORDER BY avg_ms DESC
      `).then(r => sqlRows<StageBottleneck>(r)),
    );
  }

  /** 1.7 Action failure rate — which plugin steps fail most. */
  async getActionFailures(orgId: string, from: string, to: string): Promise<ActionFailure[]> {
    return timeseriesCache.getOrSet(`${orgId}:action-failures:${from}:${to}`, () =>
      db.execute(sql`
        SELECT
          e.action_name,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failures,
          COUNT(*)::int AS total,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'FAILED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS failure_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id = ${orgId} AND e.event_type = 'ACTION' AND e.action_name IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY e.action_name ORDER BY failures DESC
      `).then(r => sqlRows<ActionFailure>(r)),
    );
  }

  /** 1.8 Error categorization — group failure messages. */
  async getErrors(orgId: string, from: string, to: string, limit: number = 20): Promise<ErrorEntry[]> {
    return timeseriesCache.getOrSet(`${orgId}:errors:${from}:${to}:${limit}`, () =>
      db.execute(sql`
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
      `).then(r => sqlRows<ErrorEntry>(r)),
    );
  }

  // ── Category 2: Plugin Inventory & Builds ──

  /** 2.1 Plugin summary — counts and breakdowns. */
  async getPluginSummary(orgId: string): Promise<PluginSummary> {
    return inventoryCache.getOrSet(`${orgId}:plugin-summary`, async () => {
      const rows = await db.execute(sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE ${schema.plugin.isActive})::int AS active,
          COUNT(*) FILTER (WHERE NOT ${schema.plugin.isActive})::int AS inactive,
          COUNT(*) FILTER (WHERE ${schema.plugin.accessModifier} = 'public')::int AS public,
          COUNT(*) FILTER (WHERE ${schema.plugin.accessModifier} = 'private')::int AS private,
          COUNT(DISTINCT ${schema.plugin.name})::int AS unique_names
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId}
      `);
      return (sqlRows<PluginSummary>(rows)[0] || { total: 0, active: 0, inactive: 0, public: 0, private: 0, uniqueNames: 0 });
    });
  }

  /** 2.2 Type & compute distribution. */
  async getPluginDistribution(orgId: string): Promise<TypeComputeDistribution[]> {
    return inventoryCache.getOrSet(`${orgId}:plugin-distribution`, () =>
      db.execute(sql`
        SELECT
          ${schema.plugin.pluginType} AS plugin_type,
          ${schema.plugin.computeType} AS compute_type,
          COUNT(*)::int AS count
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId} AND ${schema.plugin.isActive} = true
        GROUP BY ${schema.plugin.pluginType}, ${schema.plugin.computeType}
        ORDER BY count DESC
      `).then(r => sqlRows<TypeComputeDistribution>(r)),
    );
  }

  /** 2.3 Version counts per plugin name. */
  async getPluginVersions(orgId: string): Promise<VersionCount[]> {
    return inventoryCache.getOrSet(`${orgId}:plugin-versions`, () =>
      db.execute(sql`
        SELECT
          ${schema.plugin.name},
          COUNT(*)::int AS version_count,
          MAX(${schema.plugin.version}) AS latest_version,
          bool_or(${schema.plugin.isDefault}) AS has_default
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId} AND ${schema.plugin.isActive} = true
        GROUP BY ${schema.plugin.name}
        ORDER BY version_count DESC
      `).then(r => sqlRows<VersionCount>(r)),
    );
  }

  /** 2.4 Build success rate over time. */
  async getBuildSuccessRate(orgId: string, interval: string, from: string, to: string): Promise<BuildTimeSeriesEntry[]> {
    return timeseriesCache.getOrSet(`${orgId}:build-success:${interval}:${from}:${to}`, () =>
      db.execute(sql`
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
      `).then(r => sqlRows<BuildTimeSeriesEntry>(r)),
    );
  }

  /** 2.5 Build duration per plugin. */
  async getBuildDuration(orgId: string, from: string, to: string): Promise<BuildDuration[]> {
    return timeseriesCache.getOrSet(`${orgId}:build-duration:${from}:${to}`, () =>
      db.execute(sql`
        SELECT
          e.detail->>'pluginName' AS plugin_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MAX(e.duration_ms)::int AS max_ms,
          COUNT(*)::int AS builds
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id = ${orgId} AND e.event_source = 'plugin-build' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY plugin_name ORDER BY avg_ms DESC
      `).then(r => sqlRows<BuildDuration>(r)),
    );
  }

  /** 2.6 Build failures — top error messages. */
  async getBuildFailures(orgId: string, from: string, to: string, limit: number = 20): Promise<BuildFailure[]> {
    return timeseriesCache.getOrSet(`${orgId}:build-failures:${from}:${to}:${limit}`, () =>
      db.execute(sql`
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
      `).then(r => sqlRows<BuildFailure>(r)),
    );
  }
}

export const reportingService = new ReportingService();
