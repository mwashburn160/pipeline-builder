// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, scrubAwsIdentifiers, scrubAwsIdentifiersFromString } from '@pipeline-builder/api-core';
import { inArray, sql } from 'drizzle-orm';
import { drizzleRows } from './crud-service.js';
import { schema } from '../database/drizzle-schema.js';
import { withTenantTx, runWithTenantContext } from '../database/tenancy.js';

// Extracted for size — see ./reporting/. Everything public is re-exported below
// so `@pipeline-builder/pipeline-data`'s surface is unchanged by the split.
import { inventoryCache, timeseriesCache } from './reporting/caches.js';
import { DORA_INCIDENT_WINDOW_HOURS, resolveIncidentWindowHours } from './reporting/dora-scoring.js';
import {
  getDoraMetrics as doraMetrics,
  getDoraTrend as doraTrend,
  getBuildHealth as buildHealth,
} from './reporting/dora.js';
import { orgScope, runReport } from './reporting/query-scope.js';
// Aliased: the module functions and the delegating methods below share names.
import {
  REPORTING_EVENT_RETENTION_DAYS, REPORTING_DORA_RETENTION_DAYS,
  resolveEventRetentionDays, resolveDoraRetentionDays, retentionCutoff,
} from './reporting/retention.js';
import { assertReportInterval, scrubOptional, optionalStartedAtRange } from './reporting/sql-helpers.js';
import type {
  ExecutionCount, TimeSeriesEntry, DurationStats, PipelineExecution, StageFailure, StageBottleneck,
  ActionFailure, ErrorEntry, PluginSummary, TypeComputeDistribution, VersionCount,
  BuildTimeSeriesEntry, BuildDuration, BuildFailure,
  ReportingRetentionOptions, ReportingRetentionCounts,
  DoraOptions, IncidentSettings, ReportingSettingsPatch, IncidentListItem, IncidentTestResult,
  DoraMetrics, DoraTrendPoint, BuildHealth, IncidentInput,
  IngestEvent, IngestMetric, IngestResult,
} from './reporting/types.js';

// Re-export EXACTLY the surface this module had before the split — no more.
// `src/index.ts` does `export * from './api/reporting-service.js'`, so anything
// re-exported here becomes part of the package's public API. Enumerated rather
// than `export *` for that reason: the extracted modules also export internals
// (orgScope, runReport, the caches, the DORA row shapes) that were private
// before and must stay that way.
export type {
  BuildHealth, BuildHealthStage, DoraEnvMetrics, DoraLevel, DoraMetrics, DoraOptions, DoraTrendPoint,
  IncidentInput, IncidentListItem, IncidentSettings, IncidentTestResult,
  IngestEvent, IngestMetric, IngestResult,
  ReportingRetentionCounts, ReportingRetentionOptions, ReportingRetentionSettings,
  ReportingSettingsPatch,
} from './reporting/types.js';
export { resolveDoraRetentionDays, resolveEventRetentionDays, retentionCutoff } from './reporting/retention.js';


const logger = createLogger('reporting-service');

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
  async ingestEvents(events: IngestEvent[], onMetric?: (m: IngestMetric) => void): Promise<IngestResult> {
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
    const { inserted, skipped, unregisteredPipelineIds, affectedOrgs, insertedRows } = await withTenantTx(async (tx) => {
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
          // executionId is an AWS-ASSIGNED identifier (a UUID), not free-form
          // user text, so it can't carry an account id — and scrubbing a UUID
          // that happens to contain a 12-digit run would corrupt the correlation
          // key. Left intact by design.
          executionId: event.executionId,
          // stageName/actionName are USER-AUTHORED pipeline-structure names
          // promoted from the CodePipeline detail — same untrusted-AWS-derived
          // origin as errorMessage below, so scrub them at this persistence
          // boundary too (a stage named with an ARN/12-digit id must not persist).
          stageName: scrubOptional(event.stageName),
          actionName: scrubOptional(event.actionName),
          // HARD CONSTRAINT: an AWS account id must NEVER be persisted. This is
          // the DURABLE persistence boundary and must not trust upstream:
          // CodePipeline/CodeBuild failure detail & messages routinely carry
          // ARNs (arn:aws:…:<account-id>:…) and bare 12-digit account ids. Scrub
          // both free-form fields here before insert (per-event, non-mutating).
          errorMessage: scrubOptional(event.errorMessage),
          startedAt: event.startedAt ? new Date(event.startedAt) : undefined,
          completedAt: event.completedAt ? new Date(event.completedAt) : undefined,
          durationMs: event.durationMs,
          // Deploy-attribution fields — scrubbed like the other free-form strings
          // so an ARN/account id can never enter via a ref or environment name.
          commitSha: scrubOptional(event.commitSha),
          commitRef: scrubOptional(event.commitRef),
          environment: scrubOptional(event.environment),
          // Measured lead time (Phase 4): oldest unshipped commit time + count.
          // commitTimestamp is an AWS/SCM-derived instant (never account-id
          // shaped); commitCount is a plain integer. Neither needs scrubbing.
          commitTimestamp: event.commitTimestamp ? new Date(event.commitTimestamp) : undefined,
          commitCount: event.commitCount,
          detail: event.detail !== undefined
            ? scrubAwsIdentifiers(event.detail)
            : undefined,
        });

      }

      // SQS is at-least-once, so EventBridge can deliver the same state-change
      // twice. `onConflictDoNothing` + the partial unique index on
      // (pipeline_id, execution_id, event_type, status, stage_name, action_name)
      // makes re-delivery idempotent. `returning` gives the REAL inserted set so
      // counts, metrics and cache invalidation all ignore duplicates.
      const landed = rows.length > 0
        ? await tx.insert(schema.pipelineEvent).values(rows)
          .onConflictDoNothing()
          .returning({
            orgId: schema.pipelineEvent.orgId,
            pipelineId: schema.pipelineEvent.pipelineId,
            eventType: schema.pipelineEvent.eventType,
            status: schema.pipelineEvent.status,
            stageName: schema.pipelineEvent.stageName,
            environment: schema.pipelineEvent.environment,
          })
        : [];

      return {
        inserted: landed.length,
        skipped: skippedLocal,
        unregisteredPipelineIds: unregisteredLocal,
        affectedOrgs: [...new Set(landed.map(r => r.orgId))],
        insertedRows: landed,
      };
    });

    // Phase 3b: fan terminal STAGE outcomes into Prometheus counters via the
    // route's hook (pipeline-data can't import api-server's registry), after the
    // insert COMMITS. Driven off the INSERTED rows — not the request batch — so a re-delivered event
    // the dedup index swallowed is never counted twice (counters, unlike the
    // table, have no idempotency of their own). Values are the persisted,
    // already-scrubbed columns. A non-null environment also marks a deploy.
    if (onMetric) {
      for (const r of insertedRows) {
        if (r.eventType !== 'STAGE' || (r.status !== 'SUCCEEDED' && r.status !== 'FAILED') || !r.pipelineId) continue;
        onMetric({
          pipelineId: r.pipelineId,
          orgId: r.orgId,
          stage: r.stageName ?? '',
          environment: r.environment ?? null,
          result: r.status === 'SUCCEEDED' ? 'succeeded' : 'failed',
        });
      }
    }

    // Surface the silent skip: an unregistered pipeline id usually means the
    // pipeline hasn't called POST /pipelines/registry yet (or its
    // pb.pipeline-id tag is missing/unreadable by the Lambda). Logging it
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


  /** 1.1 Execution count per pipeline with status breakdown. */
  async getExecutionCount(orgId: string, orgIds?: string[], range?: { from?: string; to?: string }): Promise<ExecutionCount[]> {
    const { pred, multi } = orgScope(orgId, orgIds);
    // Optional [from,to] window on the execution's started_at, mirroring the
    // sibling timeseries reports so the dashboard date-range picker narrows the
    // count too (an empty range = all-time, preserving the prior behavior). The
    // range rides the JOIN so pipelines with no in-window events still list
    // (LEFT semantics preserved via the inner-join filter — a pipeline with zero
    // matching events drops from the count, same as before for its window).
    const rangeClause = optionalStartedAtRange(range);
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
    return runReport(`${orgId}:exec-count:${range?.from ?? ''}:${range?.to ?? ''}`, multi, exec);
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
    const { pred, multi } = orgScope(orgId, orgIds);
    const rangeClause = optionalStartedAtRange(range);
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
    return runReport(`${orgId}:pipeline-executions:${pipelineId}:${range?.from ?? ''}:${range?.to ?? ''}:${limit}`, multi, exec);
  }

  /** 1.2 Success rate over time for an org. */
  async getSuccessRate(orgId: string, interval: string, from: string, to: string, orgIds?: string[]): Promise<TimeSeriesEntry[]> {
    assertReportInterval(interval);
    const { pred, multi } = orgScope(orgId, orgIds);
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
    return runReport(`${orgId}:success-rate:${interval}:${from}:${to}`, multi, exec);
  }

  /** 1.3 Average duration per pipeline. */
  async getAverageDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<DurationStats[]> {
    const { pred, multi } = orgScope(orgId, orgIds);
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
    return runReport(`${orgId}:avg-duration:${from}:${to}`, multi, exec);
  }

  /** 1.5 Stage failure heatmap — which stages fail most. */
  async getStageFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<StageFailure[]> {
    const { pred, multi } = orgScope(orgId, orgIds);
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
    return runReport(`${orgId}:stage-failures:${from}:${to}`, multi, exec);
  }

  /**
   * Distinct deploy `environment` values observed in the window — powers the
   * DORA environment-scope datalist. Org-scoped + rollup-aware like the sibling
   * reports; only non-null environments (i.e. deploy-attributed executions).
   */
  async getReportEnvironments(orgId: string, from: string, to: string, orgIds?: string[]): Promise<string[]> {
    const { pred, multi } = orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT DISTINCT e.environment AS environment
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.environment IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        ORDER BY environment
      `).then(r => drizzleRows<{ environment: string }>(r.rows).map((row) => row.environment)));
    return runReport(`${orgId}:report-envs:${from}:${to}`, multi, exec);
  }

  /** 1.6 Stage bottlenecks — slowest stages per pipeline. */
  async getStageBottlenecks(orgId: string, from: string, to: string, orgIds?: string[]): Promise<StageBottleneck[]> {
    const { pred, multi } = orgScope(orgId, orgIds);
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
    return runReport(`${orgId}:stage-bottlenecks:${from}:${to}`, multi, exec);
  }

  /** 1.7 Action failure rate — which plugin steps fail most. */
  async getActionFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<ActionFailure[]> {
    const { pred, multi } = orgScope(orgId, orgIds);
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
    return runReport(`${orgId}:action-failures:${from}:${to}`, multi, exec);
  }

  /**
   * 1.8 Error categorization — group failure messages. Execution report, so
   * rollup-aware exactly like the sibling execution reports: with `orgIds`
   * (the org→team subtree) the org gate becomes an `IN (...)` and the read runs
   * fresh under sysadmin via `runReport`; single-org reads keep the per-org cache.
   */
  async getErrors(orgId: string, from: string, to: string, limit: number = 20, orgIds?: string[]): Promise<ErrorEntry[]> {
    const { pred, multi } = orgScope(orgId, orgIds);
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
    return runReport(`${orgId}:errors:${from}:${to}:${limit}`, multi, exec);
  }

  /**
   * The four DORA measures plus their per-environment breakdown.
   * Implementation in ./reporting/dora.ts — see that file's header for why.
   */
  getDoraMetrics(
    orgId: string, from: string, to: string, orgIds?: string[], opts: DoraOptions = {},
  ): Promise<DoraMetrics> {
    return doraMetrics(orgId, from, to, orgIds, opts);
  }

  /** DORA measures bucketed over time. */
  getDoraTrend(
    orgId: string, interval: string, from: string, to: string, orgIds?: string[], opts: DoraOptions = {},
  ): Promise<DoraTrendPoint[]> {
    return doraTrend(orgId, interval, from, to, orgIds, opts);
  }

  /** Per-pipeline build health (stage pass rates over a window). */
  getBuildHealth(
    orgId: string, pipelineId: string, from: string, to: string, orgIds?: string[],
  ): Promise<BuildHealth> {
    return buildHealth(orgId, pipelineId, from, to, orgIds);
  }

  async getPluginSummary(orgId: string): Promise<PluginSummary> {
    return inventoryCache.getOrSet(`${orgId}:plugin-summary`, async () => {
      const rows = await withTenantTx((tx) => tx.execute(sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE ${schema.plugin.isActive})::int AS active,
          COUNT(*) FILTER (WHERE NOT ${schema.plugin.isActive})::int AS inactive,
          COUNT(*) FILTER (WHERE ${schema.plugin.visibility} = 'public')::int AS public,
          COUNT(*) FILTER (WHERE ${schema.plugin.visibility} = 'org')::int AS org,
          COUNT(*) FILTER (WHERE ${schema.plugin.visibility} = 'private')::int AS private,
          COUNT(DISTINCT ${schema.plugin.name})::int AS unique_names
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId}
      `));
      return (drizzleRows<PluginSummary>(rows.rows)[0] || { total: 0, active: 0, inactive: 0, public: 0, org: 0, private: 0, uniqueNames: 0 });
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
          -- Highest version by NUMERIC semver core (not lexical: '10.0.0' > '9.0.0').
          -- Strip any -prerelease/+build suffix before the int[] cast so it can't
          -- error on valid semver; keep the original string for display.
          -- GUARD: a non-numeric-dotted version ('latest', '', 'v1') would make the
          -- ::int[] cast throw and blow up the WHOLE org summary. Only cast rows
          -- whose stripped core matches a numeric-dotted shape; sort everything
          -- else to the bottom via a sentinel ARRAY[-1] so the row still counts.
          (array_agg(${schema.plugin.version}
             ORDER BY CASE
               WHEN regexp_replace(${schema.plugin.version}, '[-+].*$', '') ~ '^[0-9]+([.][0-9]+)*$'
                 THEN string_to_array(regexp_replace(${schema.plugin.version}, '[-+].*$', ''), '.')::int[]
               ELSE ARRAY[-1]
             END DESC
          ))[1] AS latest_version,
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
    const { pred, multi } = orgScope(orgId, orgIds);
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
    return runReport(`${orgId}:build-success:${interval}:${from}:${to}`, multi, exec);
  }

  /** 2.5 Build duration per plugin. Build activity report — rollup-aware. */
  async getBuildDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<BuildDuration[]> {
    const { pred, multi } = orgScope(orgId, orgIds);
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
    return runReport(`${orgId}:build-duration:${from}:${to}`, multi, exec);
  }

  /** 2.6 Build failures — top error messages. Build activity report — rollup-aware. */
  async getBuildFailures(orgId: string, from: string, to: string, limit: number = 20, orgIds?: string[]): Promise<BuildFailure[]> {
    const { pred, multi } = orgScope(orgId, orgIds);
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
    return runReport(`${orgId}:build-failures:${from}:${to}:${limit}`, multi, exec);
  }

  // ── Category 3: DORA write paths (post-deploy outcomes + ingest health) ──

  /**
   * Record a manual post-deploy outcome marker (Phase 2): a user marks a
   * deployment `failed` (a production incident linked to the deploy) or
   * `restored` (recovered). Idempotent — keyed on (execution_id, outcome) so a
   * duplicate POST refreshes `at` rather than double-counting, while a
   * failed→restored pair stays two rows. Feeds the post-deploy CFR component and
   * the real MTTR. Runs under the caller's org context (RLS WITH CHECK).
   */
  async recordDeploymentOutcome(
    orgId: string,
    executionId: string,
    input: { outcome: 'failed' | 'restored'; at: string; environment?: string },
  ): Promise<void> {
    await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.insert(schema.deploymentOutcome).values({
        executionId,
        orgId,
        environment: scrubOptional(input.environment),
        outcome: input.outcome,
        at: new Date(input.at),
      }).onConflictDoUpdate({
        target: [schema.deploymentOutcome.executionId, schema.deploymentOutcome.outcome],
        set: {
          at: new Date(input.at),
          environment: scrubOptional(input.environment) ?? null,
        },
      })),
    );
    // Outcome changes the DORA aggregate — drop the org's cached reports.
    await this.invalidateOrg(orgId).catch((err) => {
      logger.warn('Reporting cache invalidation failed', { orgId, error: errorMessage(err) });
    });
  }

  /**
   * Ingest a production incident (Phase 5) from the org's incident tooling
   * (PagerDuty / Datadog / Alertmanager webhook). Idempotent — keyed on
   * (org_id, incident_id) so a later resolve re-post upserts `resolved_at`
   * (and refreshes the other mutable fields) instead of inserting a duplicate.
   * DORA correlates each incident to the most recent successful deploy to its
   * `environment`, producing an automated post-deploy failure + a real MTTR.
   * Runs under the caller's org context (RLS WITH CHECK); free-form fields are
   * AWS-id scrubbed at this persistence boundary like the other ingest paths.
   */
  async recordIncident(orgId: string, input: IncidentInput): Promise<void> {
    const incidentId = scrubAwsIdentifiersFromString(input.incidentId);
    const environment = scrubAwsIdentifiersFromString(input.environment);
    const severity = scrubAwsIdentifiersFromString(input.severity);
    const openedAt = new Date(input.openedAt);
    const resolvedAt = input.resolvedAt ? new Date(input.resolvedAt) : null;
    await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.insert(schema.incident).values({
        incidentId,
        orgId,
        environment,
        openedAt,
        resolvedAt,
        severity,
      }).onConflictDoUpdate({
        target: [schema.incident.orgId, schema.incident.incidentId],
        set: { environment, openedAt, resolvedAt, severity },
      })),
    );
    // A new/updated incident changes the DORA aggregate — drop cached reports.
    await this.invalidateOrg(orgId).catch((err) => {
      logger.warn('Reporting cache invalidation failed', { orgId, error: errorMessage(err) });
    });
  }

  /**
   * Read the per-org DORA settings (Phase 5b). Returns the stored
   * `incidentWindowHours` override (or `null` when unset) plus the global env
   * default, so the settings UI can show both. Runs under the caller's tenant
   * context (RLS-scoped); a single-org read.
   */
  async getIncidentSettings(orgId: string): Promise<IncidentSettings> {
    const rows = drizzleRows<{
      incident_window_hours: number | null;
      event_retention_days: number | null;
      dora_retention_days: number | null;
    }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT ${schema.doraSettings.incidentWindowHours} AS incident_window_hours,
               ${schema.doraSettings.eventRetentionDays} AS event_retention_days,
               ${schema.doraSettings.doraRetentionDays} AS dora_retention_days
        FROM ${schema.doraSettings}
        WHERE ${schema.doraSettings.orgId} = ${orgId}
        LIMIT 1
      `))).rows);
    const row = rows[0];
    return {
      incidentWindowHours: row?.incident_window_hours != null ? Number(row.incident_window_hours) : null,
      defaultWindowHours: DORA_INCIDENT_WINDOW_HOURS,
      eventRetentionDays: row?.event_retention_days != null ? Number(row.event_retention_days) : null,
      doraRetentionDays: row?.dora_retention_days != null ? Number(row.dora_retention_days) : null,
      defaultEventRetentionDays: REPORTING_EVENT_RETENTION_DAYS,
      defaultDoraRetentionDays: REPORTING_DORA_RETENTION_DAYS,
    };
  }

  /**
   * Upsert per-org reporting settings (Phase 5b incident window + Phase 7
   * retention overrides), idempotent on `org_id`. A partial write — only the
   * fields present in `patch` are set (so updating retention never clears the
   * incident window, and vice-versa). Set self-serve by an org admin via
   * `PUT /api/reports/settings/incidents`. Runs under the caller's org context
   * (RLS WITH CHECK); a changed value affects DORA aggregates so the org's
   * cached reports are dropped.
   */
  async setReportingSettings(orgId: string, patch: ReportingSettingsPatch): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.incidentWindowHours !== undefined) set.incidentWindowHours = patch.incidentWindowHours;
    if (patch.eventRetentionDays !== undefined) set.eventRetentionDays = patch.eventRetentionDays;
    if (patch.doraRetentionDays !== undefined) set.doraRetentionDays = patch.doraRetentionDays;
    await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.insert(schema.doraSettings).values({
        orgId,
        incidentWindowHours: patch.incidentWindowHours,
        eventRetentionDays: patch.eventRetentionDays,
        doraRetentionDays: patch.doraRetentionDays,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: schema.doraSettings.orgId,
        set,
      })),
    );
    await this.invalidateOrg(orgId).catch((err) => {
      logger.warn('Reporting cache invalidation failed', { orgId, error: errorMessage(err) });
    });
  }

  /**
   * List recent incidents for an org (Phase 5b org-admin surface), newest first,
   * paginated. Each row carries its resolved state and its deploy correlation —
   * the most recent SUCCESSFUL deploy to the incident's `environment` whose
   * `completed_at` falls within the effective per-org correlation window before
   * `opened_at` (the same rule DORA's CFR/MTTR correlation applies). Single-org
   * (no rollup) — an org admin views their own org's incidents. RLS-scoped via
   * the `p.org_id`/`i.org_id` predicates + the tenant context.
   */
  async listIncidents(orgId: string, opts: { limit: number; offset: number }): Promise<IncidentListItem[]> {
    const { incidentWindowHours } = await this.getIncidentSettings(orgId);
    const windowHours = resolveIncidentWindowHours(incidentWindowHours);
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const offset = Math.max(0, opts.offset);
    return withTenantTx((tx) => tx.execute(sql`
        SELECT
          i.incident_id AS "incidentId",
          i.environment AS environment,
          i.severity AS severity,
          i.opened_at::text AS "openedAt",
          i.resolved_at::text AS "resolvedAt",
          i.created_at::text AS "createdAt",
          (i.resolved_at IS NOT NULL) AS resolved,
          corr.execution_id AS "correlatedExecutionId",
          corr.completed_at::text AS "deployCompletedAt"
        FROM ${schema.incident} i
        LEFT JOIN LATERAL (
          SELECT e.execution_id, e.completed_at
          FROM ${schema.pipelineEvent} e
          JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
          WHERE p.org_id = ${orgId} AND e.event_type = 'STAGE'
            AND e.environment = i.environment AND e.status = 'SUCCEEDED'
            AND e.completed_at <= i.opened_at
            AND e.completed_at >= i.opened_at - make_interval(hours => ${windowHours}::int)
          ORDER BY e.completed_at DESC
          LIMIT 1
        ) corr ON true
        WHERE i.org_id = ${orgId}
        ORDER BY i.opened_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `).then((r) => drizzleRows<IncidentListItem>(r.rows).map((row) => ({
      ...row,
      resolved: row.resolved === true || (row.resolved as unknown) === 't',
      correlatedExecutionId: row.correlatedExecutionId ?? null,
      deployCompletedAt: row.deployCompletedAt ?? null,
    }))));
  }

  /**
   * Wiring-test dry-run (Phase 5b): would a synthetic incident opening NOW for
   * `environment` correlate to a recent successful deploy under the org's
   * effective window? This is a NON-persisting correlation check — it verifies
   * the admin's environment naming + window line up with real deploy events
   * WITHOUT writing an incident (so a "test" never pollutes CFR/MTTR). RLS-scoped.
   */
  async testIncidentCorrelation(orgId: string, environment: string): Promise<IncidentTestResult> {
    const env = scrubAwsIdentifiersFromString(environment);
    const openedAt = new Date().toISOString();
    const { incidentWindowHours } = await this.getIncidentSettings(orgId);
    const windowHours = resolveIncidentWindowHours(incidentWindowHours);
    const rows = drizzleRows<{ execution_id: string | null; completed_at: string | null }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT e.execution_id AS execution_id, e.completed_at::text AS completed_at
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id = ${orgId} AND e.event_type = 'STAGE'
          AND e.environment = ${env} AND e.status = 'SUCCEEDED'
          AND e.completed_at <= ${openedAt}::timestamptz
          AND e.completed_at >= ${openedAt}::timestamptz - make_interval(hours => ${windowHours}::int)
        ORDER BY e.completed_at DESC
        LIMIT 1
      `))).rows);
    const hit = rows[0];
    return {
      environment: env,
      openedAt,
      windowHours,
      correlated: hit?.execution_id != null,
      executionId: hit?.execution_id ?? null,
      deployCompletedAt: hit?.completed_at ?? null,
    };
  }

  /**
   * Upsert per-org ingestion health (Phase 3): the AWS events Lambda periodically
   * reports forwarded/dropped counters + the last event timestamp so the Reports
   * UI can show flowing / stale / dropping. One row per org (upsert on org_id).
   */
  async recordIngestHealth(
    orgId: string,
    input: { forwarded?: number; dropped?: number; lastEventAt?: string },
  ): Promise<void> {
    const lastEventAt = input.lastEventAt ? new Date(input.lastEventAt) : undefined;
    await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.insert(schema.ingestHealth).values({
        orgId,
        forwarded: input.forwarded,
        dropped: input.dropped,
        lastEventAt,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: schema.ingestHealth.orgId,
        set: {
          forwarded: input.forwarded,
          dropped: input.dropped,
          lastEventAt,
          updatedAt: new Date(),
        },
      })),
    );
  }

  /**
   * Batched hard-DELETE of one reporting table's rows expired past a `created_at`
   * cutoff, scoped to an org and an optional row predicate (Phase 7). Uses a
   * `ctid`-in-subquery LIMIT so each statement touches at most `batchSize` rows
   * (short lock windows, no long table scan under lock); `RETURNING 1` lets us
   * count via `.rows.length` without depending on the driver's `rowCount`. Loops
   * until a short batch (drained) or the per-tick cap, then defers the rest.
   * MUST run inside a sysadmin tenant scope (see purgeExpiredReportingData) so it
   * bypasses RLS and can delete across the org's rows.
   */
  async #purgeReportingTableBatched(
    tableSql: ReturnType<typeof sql>,
    predicate: ReturnType<typeof sql>,
    batchSize: number,
    maxBatches: number,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const res = await withTenantTx((tx) => tx.execute(sql`
        DELETE FROM ${tableSql}
        WHERE ctid IN (
          SELECT ctid FROM ${tableSql}
          WHERE ${predicate}
          LIMIT ${batchSize}
        )
        RETURNING 1
      `));
      const purged = drizzleRows<unknown>(res.rows).length;
      total += purged;
      if (purged < batchSize) break; // drained
      if (i === maxBatches - 1) {
        logger.warn('Reporting retention hit per-tick cap; remaining rows deferred', {
          purgedThisTick: total,
        });
      }
    }
    return total;
  }

  /**
   * Reporting retention sweep (Phase 7). Hard-deletes rows older than their
   * retention window, by `created_at`, across every org that has reporting data —
   * a **split** policy so high-volume standard events expire faster than the
   * low-volume DORA source:
   *  - `pipeline_events WHERE environment IS NULL` → standard-event window.
   *  - `pipeline_events WHERE environment IS NOT NULL` (deploy stages),
   *    `deployment_outcomes`, and `incidents` → DORA-source window.
   * Each org's windows come from its `dora_settings` override, else the global
   * env defaults (see {@link resolveEventRetentionDays} / {@link resolveDoraRetentionDays}).
   * `ingest_health` and `dora_settings` are never purged. One `now` for the whole
   * tick (rows crossing the boundary mid-sweep wait for the next). Establishes a
   * sysadmin tenant scope so the deletes span all orgs / bypass RLS — this is a
   * cross-tenant housekeeping job. Returns (and logs) per-window purge tallies.
   */
  async purgeExpiredReportingData(opts: ReportingRetentionOptions = {}): Promise<ReportingRetentionCounts> {
    const batchSize = Math.max(1, opts.batchSize ?? 1000);
    const maxBatches = Math.max(1, opts.maxBatchesPerTable ?? 50);
    const now = opts.now ?? new Date();
    const counts: ReportingRetentionCounts = {
      orgs: 0, standardEvents: 0, doraEvents: 0, deploymentOutcomes: 0, incidents: 0,
    };

    return runWithTenantContext({ isSuperAdmin: true }, async () => {
      // Enumerate every org with reporting data (union across the three tables).
      const orgRows = drizzleRows<{ org_id: string }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT DISTINCT org_id FROM (
          SELECT ${schema.pipelineEvent.orgId} AS org_id FROM ${schema.pipelineEvent}
          UNION
          SELECT ${schema.deploymentOutcome.orgId} AS org_id FROM ${schema.deploymentOutcome}
          UNION
          SELECT ${schema.incident.orgId} AS org_id FROM ${schema.incident}
        ) AS orgs
      `))).rows);
      if (orgRows.length === 0) return counts;

      // Per-org retention overrides (a single read; orgs without a row use defaults).
      const overrideRows = drizzleRows<{
        org_id: string;
        event_retention_days: number | null;
        dora_retention_days: number | null;
      }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT ${schema.doraSettings.orgId} AS org_id,
               ${schema.doraSettings.eventRetentionDays} AS event_retention_days,
               ${schema.doraSettings.doraRetentionDays} AS dora_retention_days
        FROM ${schema.doraSettings}
      `))).rows);
      const overrides = new Map(overrideRows.map((r) => [r.org_id, r]));

      const eventsTable = sql`${schema.pipelineEvent}`;
      const outcomesTable = sql`${schema.deploymentOutcome}`;
      const incidentsTable = sql`${schema.incident}`;

      for (const { org_id: orgId } of orgRows) {
        const ov = overrides.get(orgId);
        const eventDays = resolveEventRetentionDays(ov?.event_retention_days);
        const doraDays = resolveDoraRetentionDays(ov?.dora_retention_days);
        // `-1` = unlimited (Phase 8): keep forever, skip that window's deletes for
        // this org. Standard-event and DORA-source windows are independent; an org
        // with both `-1` is fully skipped. Log the skip so it's observable.
        const skipEvents = eventDays === -1;
        const skipDora = doraDays === -1;
        if (skipEvents || skipDora) {
          logger.info('Reporting retention sweep skipping unlimited window(s)', {
            orgId,
            standardEvents: skipEvents ? 'unlimited' : eventDays,
            doraSource: skipDora ? 'unlimited' : doraDays,
          });
        }

        if (!skipEvents) {
          const eventCutoff = retentionCutoff(now, eventDays);
          counts.standardEvents += await this.#purgeReportingTableBatched(
            eventsTable,
            sql`org_id = ${orgId} AND environment IS NULL AND created_at < ${eventCutoff}`,
            batchSize, maxBatches,
          );
        }

        if (!skipDora) {
          const doraCutoff = retentionCutoff(now, doraDays);
          counts.doraEvents += await this.#purgeReportingTableBatched(
            eventsTable,
            sql`org_id = ${orgId} AND environment IS NOT NULL AND created_at < ${doraCutoff}`,
            batchSize, maxBatches,
          );
          counts.deploymentOutcomes += await this.#purgeReportingTableBatched(
            outcomesTable,
            sql`org_id = ${orgId} AND created_at < ${doraCutoff}`,
            batchSize, maxBatches,
          );
          counts.incidents += await this.#purgeReportingTableBatched(
            incidentsTable,
            sql`org_id = ${orgId} AND created_at < ${doraCutoff}`,
            batchSize, maxBatches,
          );
        }
        counts.orgs += 1;
      }

      const purgedAny = counts.standardEvents + counts.doraEvents + counts.deploymentOutcomes + counts.incidents;
      if (purgedAny > 0) logger.info('Reporting retention sweep purged expired rows', { ...counts });
      return counts;
    });
  }
}

export const reportingService = new ReportingService();
