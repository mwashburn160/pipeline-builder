// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The analytics layer every report section and dashboard reads instead of raw
 * events.
 *
 * Reporting has been scanning `pipeline_events` directly. That worked while the
 * only consumer was one dashboard over a 30-day window, and stops working for
 * this feature: a quarterly report over a 90-day window, for an org with a
 * thousand executions a day, re-derives the same aggregates on every read, and
 * the retention sweep then deletes the rows the numbers came from. Two tables fix
 * both problems:
 *
 *  - `dora_deployments` — ONE ROW PER DEPLOY, written at ingest. Lead time is
 *    stored per execution here, never recomputed per event, because the
 *    per-event form double-counts: a deploy stage emits a STAGE event and an
 *    ACTION event, and both carry the same commit range.
 *  - `execution_daily_rollups` — one row per org, pipeline, stage and day. Every
 *    section that says "runs", "success rate", "p95" or "build minutes" reads
 *    these, so a report costs a few hundred rows instead of a few hundred
 *    thousand.
 *
 * Both are DERIVED: they can be rebuilt from events while the events exist, and
 * they outlive them afterwards. That is the point — they are the retained form.
 *
 * The other two tables here answer "what is actually running", which the report's
 * plugin sections need and no existing table can answer:
 *
 *  - `pipeline_plugin_resolution` — what a pipeline's DECLARED plugin versions
 *    resolve to, recomputed on write rather than resolved per read.
 *  - `plugin_vuln_exposure` — which pipelines are exposed to which vulnerable
 *    plugin version, opened by a rescan and closed by a fixing deploy.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/**
 * Why a deploy's lead time could not be measured. Recorded rather than left NULL
 * with no explanation, because the three causes need different fixes and the
 * report shows the reason: no SCM token for the source, the provider rate-limited
 * the range walk, or the source type has no range API at all.
 */
export const LEAD_TIME_GAPS = ['no_token', 'rate_limited', 'unsupported_source', 'no_commit_data'] as const;
export type LeadTimeGap = (typeof LEAD_TIME_GAPS)[number];

/**
 * How confidently an incident was attributed to a deploy. Shown beside change
 * failure rate and time to restore, because "this deploy broke production" and
 * "an incident opened some hours after this deploy" are different claims and a
 * manager acts differently on each.
 */
export const CORRELATION_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type CorrelationConfidence = (typeof CORRELATION_CONFIDENCES)[number];

/**
 * How a pipeline came to exist. For the adoption section: an org whose pipelines
 * are all hand-built is a different adoption story from one templating them.
 */
export const PIPELINE_CREATION_SOURCES = ['manual', 'template', 'ai', 'bulk', 'cdk'] as const;
export type PipelineCreationSource = (typeof PIPELINE_CREATION_SOURCES)[number];

/**
 * What kind of thing broke. Assigned at ingest by the classifier
 * (`api/reporting/src/services/failure-classifier.ts`), which is rules over the
 * action's type and error text — deliberately data, not code, so the taxonomy can
 * grow without a deploy.
 *
 * The categories overlap the plugin-build taxonomy on purpose: a dependency
 * failure is a dependency failure whether it happened building a plugin or
 * running one, and two vocabularies for the same thing would make the report and
 * the build queue disagree.
 */
export const FAILURE_CATEGORIES = [
  'source_checkout', 'dependency', 'build', 'unit_test', 'integration_test',
  'security_scan', 'infrastructure', 'deployment', 'authentication', 'permissions',
  'configuration', 'timeout', 'resource_exhaustion', 'external_service', 'other',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Where a plugin-version exposure was observed. */
export const EXPOSURE_SOURCES = ['declared', 'deployed'] as const;
export type ExposureSource = (typeof EXPOSURE_SOURCES)[number];

/**
 * What an org decided about an exposure. `open` until someone looks;
 * `accepted` is a time-boxed decision with a reason and an owner, never a
 * permanent mute; `false_positive` is a scanner disagreement worth recording so
 * the same finding stops being re-raised as news.
 */
export const EXPOSURE_TRIAGE_STATES = ['open', 'accepted', 'false_positive', 'fixed'] as const;
export type ExposureTriageState = (typeof EXPOSURE_TRIAGE_STATES)[number];

/**
 * One deployment: an execution that reached an environment.
 *
 * Written at ingest, one row per (execution, environment). Everything DORA
 * reports is here, so `/dora`, the trend and the report sections stop scanning
 * raw events — and keep working after the events are swept.
 *
 * @table dora_deployments
 */
export const doraDeployment = pgTable('dora_deployments', {
  orgId: varchar('org_id', { length: 255 }).notNull(),
  executionId: varchar('execution_id', { length: 255 }).notNull(),
  environment: varchar('environment', { length: 255 }).notNull(),
  pipelineId: varchar('pipeline_id', { length: 255 }),
  /** When the deploy stage completed. The deploy's own timestamp, not the run's. */
  deployedAt: timestamp('deployed_at', { withTimezone: true }).notNull(),
  succeeded: boolean('succeeded').notNull(),
  /**
   * The OLDEST unshipped commit in this deploy's range. Lead time is
   * `deployedAt - earliestCommitAt`, computed once and stored, because the
   * per-event form double-counts a deploy that emits both a STAGE and an ACTION
   * event carrying the same range.
   */
  earliestCommitAt: timestamp('earliest_commit_at', { withTimezone: true }),
  leadTimeSeconds: integer('lead_time_seconds'),
  commitCount: integer('commit_count'),
  commitSha: varchar('commit_sha', { length: 255 }),
  /** Why lead time is absent, when it is. NULL when it was measured. */
  leadTimeGap: varchar('lead_time_gap', { length: 30 }).$type<LeadTimeGap>(),
  /**
   * Post-deploy outcome markers, denormalized onto the deploy so change-failure
   * rate and time-to-restore are one scan rather than a join per window.
   */
  failedAt: timestamp('failed_at', { withTimezone: true }),
  restoredAt: timestamp('restored_at', { withTimezone: true }),
  /** How the incident→deploy link was judged. NULL when nothing was correlated. */
  correlationConfidence: varchar('correlation_confidence', { length: 10 }).$type<CorrelationConfidence>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // One row per execution per environment: a redelivered event upserts rather
  // than inserting a second deploy (EventBridge → SQS is at-least-once).
  pk: primaryKey({ columns: [table.executionId, table.environment] }),
  // The window scan every DORA read does.
  orgEnvDeployedIdx: index('dora_deployment_org_env_deployed_idx')
    .on(table.orgId, table.environment, table.deployedAt),
  orgDeployedIdx: index('dora_deployment_org_deployed_idx').on(table.orgId, table.deployedAt),
  pipelineIdx: index('dora_deployment_pipeline_idx').on(table.pipelineId, table.deployedAt),
  // The promotion view: one commit's path across environments.
  commitIdx: index('dora_deployment_commit_idx').on(table.orgId, table.commitSha)
    .where(sql`commit_sha IS NOT NULL`),
}));

/**
 * Pre-aggregated execution counts and timings, one row per org, pipeline, stage
 * and UTC day.
 *
 * Rebuilt for a day when late events arrive, so the rollup and the events agree
 * while both exist. `failuresByCategory` is a JSON map rather than a column per
 * category because the taxonomy grows.
 *
 * @table execution_daily_rollups
 */
export const executionDailyRollup = pgTable('execution_daily_rollups', {
  orgId: varchar('org_id', { length: 255 }).notNull(),
  /** The UTC date this row aggregates. Report periods re-bucket in the report's
   *  own timezone by summing days — which is why the grain is a DAY. */
  day: timestamp('day', { withTimezone: true }).notNull(),
  pipelineId: varchar('pipeline_id', { length: 255 }).notNull(),
  /** `''` for the pipeline-level row; a stage name for a stage-level row. */
  stageName: varchar('stage_name', { length: 255 }).default('').notNull(),
  runs: integer('runs').default(0).notNull(),
  succeeded: integer('succeeded').default(0).notNull(),
  failed: integer('failed').default(0).notNull(),
  /** category → count. Feeds the failure-analysis section. */
  failuresByCategory: jsonb('failures_by_category').$type<Record<string, number>>().default({}).notNull(),
  p50Ms: integer('p50_ms'),
  p90Ms: integer('p90_ms'),
  p95Ms: integer('p95_ms'),
  /** Summed execution duration, in seconds. The resource-consumption section's
   *  only input; deliberately NOT converted to money anywhere. */
  buildSeconds: integer('build_seconds').default(0).notNull(),
  /** When this row was last rebuilt, so a late-event rebuild is visible. */
  computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.orgId, table.day, table.pipelineId, table.stageName] }),
  orgDayIdx: index('execution_rollup_org_day_idx').on(table.orgId, table.day),
  pipelineDayIdx: index('execution_rollup_pipeline_day_idx').on(table.pipelineId, table.day),
}));

/**
 * What a pipeline's declared plugin steps resolve to.
 *
 * Recomputed on pipeline write and on plugin publish, rather than resolved at
 * read time: the outdated-plugin section compares "in use" against "latest
 * available" for every step of every pipeline, and doing that resolution per read
 * made it a query nobody could afford to put in a report.
 *
 * @table pipeline_plugin_resolution
 */
export const pipelinePluginResolution = pgTable('pipeline_plugin_resolution', {
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pipelineId: varchar('pipeline_id', { length: 255 }).notNull(),
  stageName: varchar('stage_name', { length: 255 }).notNull(),
  stepName: varchar('step_name', { length: 255 }).notNull(),
  pluginPublisher: varchar('plugin_publisher', { length: 39 }),
  pluginName: varchar('plugin_name', { length: 255 }).notNull(),
  /** What the config asked for — a range, a pin, or nothing. */
  declaredVersion: varchar('declared_version', { length: 50 }),
  /** What that resolves to today. NULL when nothing satisfies it. */
  resolvedVersion: varchar('resolved_version', { length: 50 }),
  /** The newest version the org is entitled to install, for the "gap" column. */
  latestVersion: varchar('latest_version', { length: 50 }),
  /** `major` / `minor` / `patch` / `none`, from resolved → latest. */
  versionGap: varchar('version_gap', { length: 10 }),
  /** False when the resolved version is outside the org's consumption policy. */
  withinPolicy: boolean('within_policy').default(true).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.pipelineId, table.stageName, table.stepName] }),
  orgIdx: index('pipeline_plugin_resolution_org_idx').on(table.orgId),
  pluginIdx: index('pipeline_plugin_resolution_plugin_idx').on(table.pluginPublisher, table.pluginName),
  // "Which pipelines are behind?" — the outdated section's driving scan.
  gapIdx: index('pipeline_plugin_resolution_gap_idx').on(table.orgId, table.versionGap),
}));

/**
 * One pipeline's exposure to one vulnerable plugin version.
 *
 * Opened by the nightly rescan when a version in use has fixable Critical/High
 * findings, and CLOSED by a deploy that moves the pipeline off it. It is a
 * per-pipeline row rather than a per-version one because the question a manager
 * asks is "which of our pipelines is exposed", and answering that from a
 * version-level table means re-deriving the pipeline set on every read.
 *
 * Keyed by IMAGE DIGEST, not version string: a version rebuilt on a patched base
 * image is a different artifact with different findings, and keying on the string
 * would report the old one forever.
 *
 * @table plugin_vuln_exposure
 */
export const pluginVulnExposure = pgTable('plugin_vuln_exposure', {
  id: varchar('id', { length: 255 }).primaryKey(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pipelineId: varchar('pipeline_id', { length: 255 }).notNull(),
  pluginPublisher: varchar('plugin_publisher', { length: 39 }),
  pluginName: varchar('plugin_name', { length: 255 }).notNull(),
  pluginVersion: varchar('plugin_version', { length: 50 }).notNull(),
  imageDigest: varchar('image_digest', { length: 71 }),
  source: varchar('source', { length: 10 }).$type<ExposureSource>().notNull(),
  criticalCount: integer('critical_count').default(0).notNull(),
  highCount: integer('high_count').default(0).notNull(),
  /** The findings themselves: CVE id, package, fixed-in version. Capped by the writer. */
  topFindings: jsonb('top_findings').$type<Array<Record<string, unknown>>>().default([]).notNull(),
  flaggedAt: timestamp('flagged_at', { withTimezone: true }).defaultNow().notNull(),
  /** Set when a deploy moved the pipeline onto a version without the findings. */
  fixedAt: timestamp('fixed_at', { withTimezone: true }),
  triageState: varchar('triage_state', { length: 20 }).$type<ExposureTriageState>().default('open').notNull(),
  /** An acceptance is time-boxed: a permanent mute is how a finding is forgotten. */
  acceptedUntil: timestamp('accepted_until', { withTimezone: true }),
  triageReason: text('triage_reason'),
  triagedBy: text('triaged_by'),
  triagedAt: timestamp('triaged_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // One live exposure per (pipeline, plugin version, digest, source): a nightly
  // rescan refreshes counts rather than opening a new row every night.
  exposureUnique: uniqueIndex('plugin_vuln_exposure_unique')
    .on(table.pipelineId, table.pluginName, table.pluginVersion, table.source),
  orgOpenIdx: index('plugin_vuln_exposure_org_open_idx').on(table.orgId, table.triageState)
    .where(sql`fixed_at IS NULL`),
  digestIdx: index('plugin_vuln_exposure_digest_idx').on(table.imageDigest),
}));

export type DoraDeployment = typeof doraDeployment.$inferSelect;
export type DoraDeploymentInsert = typeof doraDeployment.$inferInsert;
export type ExecutionDailyRollup = typeof executionDailyRollup.$inferSelect;
export type ExecutionDailyRollupInsert = typeof executionDailyRollup.$inferInsert;
export type PipelinePluginResolution = typeof pipelinePluginResolution.$inferSelect;
export type PipelinePluginResolutionInsert = typeof pipelinePluginResolution.$inferInsert;
export type PluginVulnExposure = typeof pluginVulnExposure.$inferSelect;
export type PluginVulnExposureInsert = typeof pluginVulnExposure.$inferInsert;
