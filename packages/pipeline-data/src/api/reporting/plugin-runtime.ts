// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-plugin RUNTIME telemetry (plugin-ecosystem W0.1): how plugins behave when
 * pipelines run them, as opposed to the plugin BUILD reports. Reads the
 * `plugin_publisher/plugin_name/plugin_version` that event ingest stamps on
 * ACTION events from the pipeline's step manifest.
 *
 * A "run" is one terminal ACTION event — SUCCEEDED or FAILED. Canceled,
 * abandoned and superseded actions say nothing about the plugin and are left
 * out of both the count and the rate.
 *
 * Two audiences:
 *   - the org's own dashboard ({@link getPluginRuntime}): org-scoped (rollup
 *     aware), grouped per plugin version;
 *   - the ecosystem, service-to-service ({@link getPluginRuntimeAggregate},
 *     {@link hasVerifiedPluginUse}): cross-org aggregates keyed on a listing's
 *     `(publisher, name)`, feeding `plugin_stats` and the review "verified use"
 *     badge. Never exposed to a user token — they read every org's events.
 */

import { sql } from 'drizzle-orm';
import { orgScope, runReport } from './query-scope.js';
import type { PluginRuntimeAggregate, PluginRuntimeFilter, PluginRuntimeStats } from './types.js';
import { schema } from '../../database/drizzle-schema.js';
import { runWithTenantContext, withTenantTx } from '../../database/tenancy.js';
import { drizzleRows } from '../crud-service.js';

/** Window for the ecosystem aggregate (`plugin_stats.success_rate_30d`). */
export const PLUGIN_RUNTIME_AGGREGATE_DAYS = 30;
/** Window for review "verified use" (§5): a successful run in the last 90 days. */
export const PLUGIN_VERIFIED_USE_DAYS = 90;

/** The terminal-ACTION, plugin-attributed predicate every runtime read shares (alias `e`). */
const pluginRuns = sql`e.event_type = 'ACTION' AND e.plugin_name IS NOT NULL
          AND e.status IN ('SUCCEEDED', 'FAILED')`;

/** `IS NULL` for an own-org (publisher-less) plugin, `=` otherwise. */
function publisherPredicate(publisher: string | null) {
  return publisher === null ? sql`e.plugin_publisher IS NULL` : sql`e.plugin_publisher = ${publisher}`;
}

/**
 * Per plugin version: runs, success rate and duration (p50/p95) over
 * `[from, to]` on `completed_at`, for the org (or its rollup subtree).
 * Optional filters narrow to one plugin name / publisher (`null` = own-org
 * plugins) / version.
 */
export async function getPluginRuntime(
  orgId: string,
  from: string,
  to: string,
  filter: PluginRuntimeFilter = {},
  orgIds?: string[],
): Promise<PluginRuntimeStats[]> {
  const { pred, multi } = orgScope(orgId, orgIds);
  const nameClause = filter.name !== undefined ? sql`AND e.plugin_name = ${filter.name}` : sql``;
  const publisherClause = filter.publisher !== undefined ? sql`AND ${publisherPredicate(filter.publisher)}` : sql``;
  const versionClause = filter.version !== undefined ? sql`AND e.plugin_version = ${filter.version}` : sql``;
  const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.plugin_publisher AS "pluginPublisher",
          e.plugin_name AS "pluginName",
          e.plugin_version AS "pluginVersion",
          COUNT(*)::int AS runs,
          COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failed,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS "successPct",
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY e.duration_ms)::int AS "p50Ms",
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.duration_ms)::int AS "p95Ms",
          MAX(e.completed_at)::text AS "lastRun"
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND ${pluginRuns}
          AND e.completed_at >= ${from}::timestamptz AND e.completed_at <= ${to}::timestamptz
          ${nameClause} ${publisherClause} ${versionClause}
        GROUP BY e.plugin_publisher, e.plugin_name, e.plugin_version
        ORDER BY runs DESC
      `).then(r => drizzleRows<PluginRuntimeStats>(r.rows)));
  const filterKey = `${filter.name ?? ''}:${filter.publisher === null ? '\u0000' : filter.publisher ?? ''}:${filter.version ?? ''}`;
  return runReport(`${orgId}:plugin-runtime:${from}:${to}:${filterKey}`, multi, exec);
}

/**
 * Ecosystem aggregate for one listing over the last 30 days, across EVERY org:
 * runs, success rate (0–1; null with no runs) and how many distinct orgs ran it.
 * Runs under system context — the caller is the plugin service computing
 * `plugin_stats`, and `activeOrgCount30d` is only ever shown at ≥ 5 (§5a view).
 */
export async function getPluginRuntimeAggregate(publisher: string, name: string): Promise<PluginRuntimeAggregate> {
  const rows = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          COUNT(*)::int AS "runs30d",
          (COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::float
            / NULLIF(COUNT(*), 0)) AS "successRate30d",
          COUNT(DISTINCT e.org_id)::int AS "activeOrgCount30d"
        FROM ${schema.pipelineEvent} e
        WHERE ${pluginRuns} AND ${publisherPredicate(publisher)} AND e.plugin_name = ${name}
          AND e.completed_at >= now() - make_interval(days => ${PLUGIN_RUNTIME_AGGREGATE_DAYS})
      `).then(r => drizzleRows<PluginRuntimeAggregate>(r.rows))));
  return rows[0] ?? { runs30d: 0, successRate30d: null, activeOrgCount30d: 0 };
}

/**
 * Review "verified use" (§5): did `orgId` run `(publisher, name)` successfully
 * in the last 90 days? Bounded by the org's event retention — a run older than
 * the retention horizon has been swept and no longer counts.
 */
export async function hasVerifiedPluginUse(orgId: string, publisher: string, name: string): Promise<boolean> {
  const rows = await runWithTenantContext({ orgId, isSuperAdmin: false }, () => withTenantTx((tx) => tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM ${schema.pipelineEvent} e
          WHERE e.org_id = ${orgId} AND ${pluginRuns} AND e.status = 'SUCCEEDED'
            AND ${publisherPredicate(publisher)} AND e.plugin_name = ${name}
            AND e.completed_at >= now() - make_interval(days => ${PLUGIN_VERIFIED_USE_DAYS})
        ) AS "verified"
      `).then(r => drizzleRows<{ verified: boolean }>(r.rows))));
  return rows[0]?.verified === true;
}
