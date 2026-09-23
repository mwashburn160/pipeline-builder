// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, scrubAwsIdentifiersFromString } from '@pipeline-builder/api-core';
import { eq, sql } from 'drizzle-orm';
import { drizzleRows } from './crud-service.js';
import { schema } from '../database/drizzle-schema.js';
import { withTenantTx, runWithTenantContext } from '../database/tenancy.js';

// Extracted for size — see ./reporting/. Everything public is re-exported below
// so `@pipeline-builder/pipeline-data`'s surface is unchanged by the split.
import { inventoryCache, invalidateOrgReports } from './reporting/caches.js';
import { DORA_INCIDENT_WINDOW_HOURS, resolveIncidentWindowHours } from './reporting/dora-scoring.js';
import {
  getDoraMetrics as doraMetrics,
  getDoraTrend as doraTrend,
  getBuildHealth as buildHealth,
} from './reporting/dora.js';
// Aliased: the module functions and the delegating methods below share names.
import { ingestEvents as ingest } from './reporting/ingest.js';
import {
  getPluginRuntime as pluginRuntime,
  getPluginRuntimeAggregate as pluginRuntimeAggregate,
  hasVerifiedPluginUse as verifiedPluginUse,
} from './reporting/plugin-runtime.js';
import { report } from './reporting/query-scope.js';
import { purgeExpiredReportingData as purgeReportingRetention } from './reporting/retention-sweep.js';
import { REPORTING_EVENT_RETENTION_DAYS, REPORTING_DORA_RETENTION_DAYS } from './reporting/retention.js';
import { assertReportInterval, scrubOptional, optionalStartedAtRange, startedAtWindow } from './reporting/sql-helpers.js';
import type {
  ExecutionCount, TimeSeriesEntry, DurationStats, PipelineExecution, StageFailure, StageBottleneck,
  ActionFailure, ErrorEntry, PluginSummary, TypeComputeDistribution, VersionCount,
  BuildTimeSeriesEntry, BuildDuration, BuildFailure,
  PluginRuntimeAggregate, PluginRuntimeFilter, PluginRuntimeStats,
  ReportingRetentionOptions, ReportingRetentionCounts,
  DoraOptions, ReportingSettings, ReportingSettingsPatch, IncidentListItem, IncidentTestResult,
  DoraMetrics, DoraTrendPoint, BuildHealth, IncidentInput,
  IngestEvent, IngestMetric, IngestResult, IngestHealthStatus,
} from './reporting/types.js';

// The reporting types that are part of the package API. Enumerated rather than
// `export *` because the reporting modules also export internals (orgScope,
// runReport, the caches, the DORA row shapes) that must stay private.
export type {
  BuildHealth, BuildHealthStage, DoraEnvMetrics, DoraLevel, DoraMetrics, DoraOptions, DoraTrendPoint,
  IncidentInput, IncidentListItem, ReportingSettings, IncidentTestResult,
  IngestEvent, IngestHealthStatus, IngestMetric, IngestResult,
  PluginRuntimeAggregate, PluginRuntimeFilter, PluginRuntimeStats,
  ReportingRetentionCounts, ReportingRetentionOptions, ReportingRetentionSettings,
  ReportingSettingsPatch,
} from './reporting/types.js';


const logger = createLogger('reporting-service');

export class ReportingService {

  /** Invalidate all cached reports for an org (call after event ingest). */
  async invalidateOrg(orgId: string): Promise<void> {
    await invalidateOrgReports(orgId);
  }

  /**
   * Resolve incoming events against the pipeline registry, batch-insert the
   * matched ones, and invalidate reporting caches for affected orgs.
   * See ./reporting/ingest.ts — the caller must already hold a sysadmin
   * tenant scope, because a batch spans whatever orgs the registry resolves to.
   */
  async ingestEvents(events: IngestEvent[], onMetric?: (m: IngestMetric) => void): Promise<IngestResult> {
    return ingest(events, onMetric);
  }

  // ── Category 1: Pipeline Execution & Performance ──


  /** Execution count per pipeline with status breakdown. */
  async getExecutionCount(orgId: string, orgIds?: string[], range?: { from?: string; to?: string }): Promise<ExecutionCount[]> {
    // Optional [from,to] window on the execution's started_at, mirroring the
    // sibling timeseries reports so the dashboard date-range picker narrows the
    // count too (an empty range = all-time, preserving the prior behavior). The
    // range rides the JOIN so pipelines with no in-window events still list
    // (LEFT semantics preserved via the inner-join filter — a pipeline with zero
    // matching events drops from the count, same as before for its window).
    const rangeClause = optionalStartedAtRange(range);
    return report<ExecutionCount>(`exec-count:${range?.from ?? ''}:${range?.to ?? ''}`, orgId, orgIds, (pred) => sql`
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
      `);
  }

  /**
   * Per-pipeline execution history — DISTINCT executions for one pipeline,
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
    const rangeClause = optionalStartedAtRange(range);
    return report<PipelineExecution>(`pipeline-executions:${pipelineId}:${range?.from ?? ''}:${range?.to ?? ''}:${limit}`, orgId, orgIds, (pred) => sql`
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
      `);
  }

  /** Success rate over time for an org. */
  async getSuccessRate(orgId: string, interval: string, from: string, to: string, orgIds?: string[]): Promise<TimeSeriesEntry[]> {
    assertReportInterval(interval);
    return report<TimeSeriesEntry>(`success-rate:${interval}:${from}:${to}`, orgId, orgIds, (pred) => sql`
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
          AND ${startedAtWindow(from, to)}
        GROUP BY period ORDER BY period
      `);
  }

  /** Average duration per pipeline. */
  async getAverageDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<DurationStats[]> {
    return report<DurationStats>(`avg-duration:${from}:${to}`, orgId, orgIds, (pred) => sql`
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
          AND ${startedAtWindow(from, to)}
        GROUP BY p.id ORDER BY avg_ms DESC
      `);
  }

  /** Stage failure heatmap — which stages fail most. */
  async getStageFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<StageFailure[]> {
    return report<StageFailure>(`stage-failures:${from}:${to}`, orgId, orgIds, (pred) => sql`
        SELECT
          e.stage_name,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failures,
          COUNT(*)::int AS total,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'FAILED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS failure_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.stage_name IS NOT NULL
          AND ${startedAtWindow(from, to)}
        GROUP BY e.stage_name ORDER BY failures DESC
      `);
  }

  /**
   * Distinct deploy `environment` values observed in the window — powers the
   * DORA environment-scope datalist. Org-scoped + rollup-aware like the sibling
   * reports; only non-null environments (i.e. deploy-attributed executions).
   */
  async getReportEnvironments(orgId: string, from: string, to: string, orgIds?: string[]): Promise<string[]> {
    const rows = await report<{ environment: string }>(`report-envs:${from}:${to}`, orgId, orgIds, (pred) => sql`
        SELECT DISTINCT e.environment AS environment
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.environment IS NOT NULL
          AND ${startedAtWindow(from, to)}
        ORDER BY environment
      `);
    return rows.map((row) => row.environment);
  }

  /** Stage bottlenecks — slowest stages per pipeline. */
  async getStageBottlenecks(orgId: string, from: string, to: string, orgIds?: string[]): Promise<StageBottleneck[]> {
    return report<StageBottleneck>(`stage-bottlenecks:${from}:${to}`, orgId, orgIds, (pred) => sql`
        SELECT
          p.id, p.pipeline_name, e.stage_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MAX(e.duration_ms)::int AS max_ms
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.duration_ms IS NOT NULL
          AND ${startedAtWindow(from, to)}
        GROUP BY p.id, e.stage_name ORDER BY avg_ms DESC
      `);
  }

  /** Action failure rate — which plugin steps fail most. */
  async getActionFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<ActionFailure[]> {
    return report<ActionFailure>(`action-failures:${from}:${to}`, orgId, orgIds, (pred) => sql`
        SELECT
          e.action_name,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failures,
          COUNT(*)::int AS total,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'FAILED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS failure_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'ACTION' AND e.action_name IS NOT NULL
          AND ${startedAtWindow(from, to)}
        GROUP BY e.action_name ORDER BY failures DESC
      `);
  }

  /**
   * Error categorization — group failure messages. Execution report, so
   * rollup-aware exactly like the sibling execution reports: with `orgIds`
   * (the org→team subtree) the org gate becomes an `IN (...)` and the read runs
   * fresh under sysadmin via `runReport`; single-org reads keep the per-org cache.
   */
  async getErrors(orgId: string, from: string, to: string, limit: number = 20, orgIds?: string[]): Promise<ErrorEntry[]> {
    return report<ErrorEntry>(`errors:${from}:${to}:${limit}`, orgId, orgIds, (pred) => sql`
        SELECT
          SUBSTRING(e.error_message FROM 1 FOR 200) AS error_pattern,
          COUNT(*)::int AS occurrences,
          COUNT(DISTINCT e.pipeline_id)::int AS affected_pipelines,
          MAX(e.started_at)::text AS last_seen
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.status = 'FAILED' AND e.error_message IS NOT NULL
          AND ${startedAtWindow(from, to)}
        GROUP BY error_pattern ORDER BY occurrences DESC
        LIMIT ${limit}
      `);
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

  /** Type & compute distribution.
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

  /** Version counts per plugin name.
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
   * Build success rate over time.
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
    return report<BuildTimeSeriesEntry>(`build-success:${interval}:${from}:${to}`, orgId, orgIds, (pred) => sql`
        SELECT
          DATE_TRUNC(${interval}, e.started_at)::text AS period,
          COUNT(*) FILTER (WHERE e.status = 'completed')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'failed')::int AS failed,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'completed')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS success_pct
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND e.event_source = 'plugin-build'
          AND e.status IN ('completed', 'failed')
          AND ${startedAtWindow(from, to)}
        GROUP BY period ORDER BY period
      `);
  }

  /** Build duration per plugin. Build activity report — rollup-aware. */
  async getBuildDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<BuildDuration[]> {
    return report<BuildDuration>(`build-duration:${from}:${to}`, orgId, orgIds, (pred) => sql`
        SELECT
          e.detail->>'pluginName' AS plugin_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MAX(e.duration_ms)::int AS max_ms,
          COUNT(*)::int AS builds
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND e.event_source = 'plugin-build' AND e.duration_ms IS NOT NULL
          AND ${startedAtWindow(from, to)}
        GROUP BY plugin_name ORDER BY avg_ms DESC
      `);
  }

  /** Build failures — top error messages. Build activity report — rollup-aware. */
  async getBuildFailures(orgId: string, from: string, to: string, limit: number = 20, orgIds?: string[]): Promise<BuildFailure[]> {
    return report<BuildFailure>(`build-failures:${from}:${to}:${limit}`, orgId, orgIds, (pred) => sql`
        SELECT
          e.detail->>'pluginName' AS plugin_name,
          e.error_message,
          COUNT(*)::int AS occurrences,
          MAX(e.started_at)::text AS last_seen
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND e.event_source = 'plugin-build' AND e.status = 'failed'
          AND ${startedAtWindow(from, to)}
        GROUP BY plugin_name, e.error_message
        ORDER BY occurrences DESC
        LIMIT ${limit}
      `);
  }

  // ── Plugin runtime telemetry — see ./reporting/plugin-runtime.ts ──

  /**
   * Plugin runtime: per plugin version runs, success rate and p50/p95
   * duration over `[from, to]`, from the manifest-attributed ACTION events.
   * Rollup-aware.
   */
  async getPluginRuntime(orgId: string, from: string, to: string, filter?: PluginRuntimeFilter, orgIds?: string[]): Promise<PluginRuntimeStats[]> {
    return pluginRuntime(orgId, from, to, filter, orgIds);
  }

  /** Cross-org 30-day runtime aggregate for a `(publisher, name)` listing (plugin_stats input). Service callers only. */
  async getPluginRuntimeAggregate(publisher: string, name: string): Promise<PluginRuntimeAggregate> {
    return pluginRuntimeAggregate(publisher, name);
  }

  /** Review "verified use": `orgId` ran `(publisher, name)` successfully within 90 days. Service callers only. */
  async hasVerifiedPluginUse(orgId: string, publisher: string, name: string): Promise<boolean> {
    return verifiedPluginUse(orgId, publisher, name);
  }

  // ── Category 3: DORA write paths (post-deploy outcomes + ingest health) ──

  /**
   * Record a manual post-deploy outcome marker: a user marks a
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
   * Ingest a production incident from the org's incident tooling
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
        // A redelivered FIRING post (no resolvedAt) must not wipe a recorded
        // resolve — senders re-post firing alerts on every repeat interval, and
        // delivery order isn't guaranteed. Keep the stored resolve unless the
        // post carries its own, or the incident was RE-OPENED (a different
        // openedAt means a new occurrence, whose resolve state is the post's).
        set: {
          environment,
          openedAt,
          resolvedAt: sql`CASE WHEN ${schema.incident.openedAt} = excluded.opened_at
            THEN COALESCE(excluded.resolved_at, ${schema.incident.resolvedAt})
            ELSE excluded.resolved_at END`,
          severity,
        },
      })),
    );
    // A new/updated incident changes the DORA aggregate — drop cached reports.
    await this.invalidateOrg(orgId).catch((err) => {
      logger.warn('Reporting cache invalidation failed', { orgId, error: errorMessage(err) });
    });
  }

  /**
   * Read the per-org DORA settings. Returns the stored
   * `incidentWindowHours` override (or `null` when unset) plus the global env
   * default, so the settings UI can show both. Runs under the caller's tenant
   * context (RLS-scoped); a single-org read.
   */
  async getReportingSettings(orgId: string, retentionOrgId: string = orgId): Promise<ReportingSettings> {
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
    // Retention is a billing entitlement synced onto the account ROOT only; a
    // team reads its root's window (the incident window stays the team's own).
    const retention = retentionOrgId === orgId
      ? row
      : await this.#readRetentionOverride(retentionOrgId);
    return {
      incidentWindowHours: row?.incident_window_hours != null ? Number(row.incident_window_hours) : null,
      defaultWindowHours: DORA_INCIDENT_WINDOW_HOURS,
      eventRetentionDays: retention?.event_retention_days != null ? Number(retention.event_retention_days) : null,
      doraRetentionDays: retention?.dora_retention_days != null ? Number(retention.dora_retention_days) : null,
      defaultEventRetentionDays: REPORTING_EVENT_RETENTION_DAYS,
      defaultDoraRetentionDays: REPORTING_DORA_RETENTION_DAYS,
    };
  }

  /**
   * The ROOT org's stored retention override. The caller (a team) can't see the
   * root's `dora_settings` row under its own RLS scope, so this narrow read of
   * two integer columns — keyed by the explicit, JWT-derived root id — runs in a
   * sysadmin scope.
   */
  async #readRetentionOverride(orgId: string): Promise<{ event_retention_days: number | null; dora_retention_days: number | null } | undefined> {
    const rows = await runWithTenantContext({ isSuperAdmin: true }, async () => drizzleRows<{
      event_retention_days: number | null;
      dora_retention_days: number | null;
    }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT ${schema.doraSettings.eventRetentionDays} AS event_retention_days,
               ${schema.doraSettings.doraRetentionDays} AS dora_retention_days
        FROM ${schema.doraSettings}
        WHERE ${schema.doraSettings.orgId} = ${orgId}
        LIMIT 1
      `))).rows));
    return rows[0];
  }

  /**
   * Upsert per-org reporting settings (incident window +
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
   * List recent incidents for an org (org-admin surface), newest first,
   * paginated. Each row carries its resolved state and its deploy correlation —
   * the most recent SUCCESSFUL deploy to the incident's `environment` whose
   * `completed_at` falls within the effective per-org correlation window before
   * `opened_at` (the same rule DORA's CFR/MTTR correlation applies). Single-org
   * (no rollup) — an org admin views their own org's incidents. RLS-scoped via
   * the `p.org_id`/`i.org_id` predicates + the tenant context.
   */
  async listIncidents(orgId: string, opts: { limit: number; offset: number }): Promise<IncidentListItem[]> {
    const { incidentWindowHours } = await this.getReportingSettings(orgId);
    const windowHours = resolveIncidentWindowHours(incidentWindowHours);
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const offset = Math.max(0, opts.offset);
    // The correlation window is expressed in SECONDS as a double, not as
    // `make_interval(hours => N::int)`. The window is validated as any positive
    // number (0.5h is legal) and the in-memory DORA correlation uses it exactly;
    // the int cast made Postgres reject a fractional value, so a 0.5h window
    // returned 500 from this endpoint and from the correlation lookup below.
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
            AND e.completed_at >= i.opened_at - make_interval(secs => ${windowHours * 3600}::double precision)
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
   * Wiring-test dry-run: would a synthetic incident opening NOW for
   * `environment` correlate to a recent successful deploy under the org's
   * effective window? This is a NON-persisting correlation check — it verifies
   * the admin's environment naming + window line up with real deploy events
   * WITHOUT writing an incident (so a "test" never pollutes CFR/MTTR). RLS-scoped.
   */
  async testIncidentCorrelation(orgId: string, environment: string): Promise<IncidentTestResult> {
    const env = scrubAwsIdentifiersFromString(environment);
    const openedAt = new Date().toISOString();
    const { incidentWindowHours } = await this.getReportingSettings(orgId);
    const windowHours = resolveIncidentWindowHours(incidentWindowHours);
    const rows = drizzleRows<{ execution_id: string | null; completed_at: string | null }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT e.execution_id AS execution_id, e.completed_at::text AS completed_at
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id = ${orgId} AND e.event_type = 'STAGE'
          AND e.environment = ${env} AND e.status = 'SUCCEEDED'
          AND e.completed_at <= ${openedAt}::timestamptz
          AND e.completed_at >= ${openedAt}::timestamptz - make_interval(secs => ${windowHours * 3600}::double precision)
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
   * Upsert per-org ingestion health: the AWS events Lambda periodically
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
   * Read back one org's ingestion health for the Reports UI freshness
   * indicator. Returns `null` when the org has NO row — i.e. the deployment has
   * never ingested anything — which the UI must render as "no ingest reported
   * yet", never as "stale". RLS-scoped to the org like every other read.
   */
  async getIngestHealth(orgId: string): Promise<IngestHealthStatus | null> {
    const rows = await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx
        .select()
        .from(schema.ingestHealth)
        .where(eq(schema.ingestHealth.orgId, orgId))
        .limit(1)),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      updatedAt: row.updatedAt.toISOString(),
      lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
      forwarded: row.forwarded ?? null,
      dropped: row.dropped ?? null,
    };
  }

  /**
   * Reporting retention sweep: hard-deletes rows past their per-org retention
   * window (split standard-event vs DORA-source). Cross-tenant housekeeping —
   * it establishes its own sysadmin scope. See ./reporting/retention-sweep.ts.
   */
  async purgeExpiredReportingData(opts: ReportingRetentionOptions = {}): Promise<ReportingRetentionCounts> {
    return purgeReportingRetention(opts);
  }
}

export const reportingService = new ReportingService();
