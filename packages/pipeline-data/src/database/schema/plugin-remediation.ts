// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly plugin CVE remediation (docs/plugin-publishing.md "Scan gates"). The
 * vocabulary — stages, outcomes, reasons, modes — lives in api-core
 * (`types/plugin-remediation.ts`); the CHECKs below spell the same lists.
 *
 * Every table here is OWN-ORG ONLY under RLS (no system-org read carve-out): a
 * remediation names a version's findings and its patch, which are the owning
 * org's business, including the system org's (Official) remediations. Cross-org
 * reads (the pipeline service resolving a team's root settings, the purge
 * sweep's orphan retry) run under sysadmin scope with explicit org ids.
 */

import type {
  LibraryUpgradeLevel,
  PipelineRemediationUpgradeState,
  PluginRemediationKind,
  PluginRemediationMode,
  PluginRemediationOutcome,
  PluginRemediationStage,
  PluginScanFinding,
  PluginSourceOrphanKind,
  RemediationClearedFinding,
  RemediationFixMethod,
  RemediationProposeReason,
  RemediationRemainingFinding,
  RemediationRolloutSummary,
  RemediationVersionBump,
  TeamRemediationRollout,
  ToolchainFixCandidate,
  GrypePackageType,
} from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { pipeline } from './pipeline.js';
import { plugin } from './plugin.js';

/**
 * One remediation of one flagged plugin version.
 *
 * Idempotency: at most one LIVE row per (plugin_id, findings_hash)
 * (`plugin_remediation_live_unique`), and at most one row per version still
 * building or awaiting approval (`plugin_remediation_active_version_unique`).
 * A failed / needs_owner / done row for the same hash stops the nightly pass
 * re-queueing it until the findings (or their fixed versions) change; `POST
 * …/retry` inserts a new row (`attempt + 1`, `retry_of`).
 *
 * `plugin_id` cascades: purging the flagged version removes its remediations
 * (after their audit entries are written). `to_plugin_id` is SET NULL: deleting
 * a fix version leaves the remediation of the version it fixed.
 *
 * @table plugin_remediations
 */
export const pluginRemediation = pgTable('plugin_remediations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pluginId: uuid('plugin_id').notNull().references(() => plugin.id, { onDelete: 'cascade' }),
  pluginName: varchar('plugin_name', { length: 255 }).notNull(),
  fromVersion: varchar('from_version', { length: 50 }).notNull(),
  findingsHash: varchar('findings_hash', { length: 64 }).notNull(),
  stage: varchar('stage', { length: 20 }).$type<PluginRemediationStage>().default('queued').notNull(),
  outcome: varchar('outcome', { length: 20 }).$type<PluginRemediationOutcome>(),
  toVersion: varchar('to_version', { length: 50 }),
  toPluginId: uuid('to_plugin_id').references(() => plugin.id, { onDelete: 'set null' }),
  versionBump: varchar('version_bump', { length: 10 }).$type<RemediationVersionBump>(),
  upgradeLevel: varchar('upgrade_level', { length: 10 }).$type<LibraryUpgradeLevel>(),
  publishMode: varchar('publish_mode', { length: 10 }).$type<Exclude<PluginRemediationMode, 'off'>>(),
  proposeReasons: text('propose_reasons').array().$type<RemediationProposeReason[]>().default([]).notNull(),
  fixMethods: text('fix_methods').array().$type<RemediationFixMethod[]>().default([]).notNull(),
  targeted: jsonb('targeted').$type<PluginScanFinding[]>().default([]).notNull(),
  cleared: jsonb('cleared').$type<RemediationClearedFinding[]>().default([]).notNull(),
  remaining: jsonb('remaining').$type<RemediationRemainingFinding[]>().default([]).notNull(),
  /** plugin-sources key of remediation.diff (api-core `remediationDiffKey`). */
  patchKey: text('patch_key'),
  /** Official only: plugin-sources key of the deploy/plugins/** export (`remediationExportKey`). */
  exportKey: text('export_key'),
  /** `plugin` (a version's fix) | `toolchain` (a managed toolchain release candidate, propose-only). */
  kind: varchar('kind', { length: 10 }).$type<PluginRemediationKind>().default('plugin').notNull(),
  /** kind = toolchain: the verified candidate pair and its spec change. */
  toolchainCandidate: jsonb('toolchain_candidate').$type<ToolchainFixCandidate>(),
  rollout: jsonb('rollout').$type<RemediationRolloutSummary>(),
  /** Official fixes: the listing new-version publish request opened for it. */
  publishRequestId: uuid('publish_request_id'),
  ownerRequestSentAt: timestamp('owner_request_sent_at', { withTimezone: true }),
  /** A short error CODE (never raw log text). */
  error: varchar('error', { length: 64 }),
  attempt: integer('attempt').default(1).notNull(),
  retryOf: uuid('retry_of'),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => ({
  liveUnique: uniqueIndex('plugin_remediation_live_unique').on(table.pluginId, table.findingsHash)
    .where(sql`stage IN ('queued', 'rebuild', 'libraries', 'awaiting_approval', 'published', 'rolling_out', 'needs_review')`),
  activeVersionUnique: uniqueIndex('plugin_remediation_active_version_unique').on(table.pluginId)
    .where(sql`stage IN ('queued', 'rebuild', 'libraries', 'awaiting_approval')`),
  findingsIdx: index('plugin_remediation_findings_idx').on(table.pluginId, table.findingsHash),
  orgStageIdx: index('plugin_remediation_org_stage_idx').on(table.orgId, table.stage, sql`${table.createdAt} DESC`),
  toPluginIdx: index('plugin_remediation_to_plugin_idx').on(table.toPluginId).where(sql`to_plugin_id IS NOT NULL`),
  stageCheck: check('plugin_remediation_stage_check', sql`${table.stage} IN ('queued', 'rebuild', 'libraries', 'awaiting_approval', 'published', 'rolling_out', 'done', 'needs_owner', 'needs_review', 'failed')`),
  outcomeCheck: check('plugin_remediation_outcome_check', sql`${table.outcome} IS NULL OR ${table.outcome} IN ('cleared', 'partial', 'owner_request', 'rejected', 'cancelled', 'superseded', 'error')`),
  hashCheck: check('plugin_remediation_findings_hash_check', sql`${table.findingsHash} ~ '^[0-9a-f]{64}$'`),
  bumpCheck: check('plugin_remediation_version_bump_check', sql`${table.versionBump} IS NULL OR ${table.versionBump} IN ('patch', 'minor')`),
  levelCheck: check('plugin_remediation_upgrade_level_check', sql`${table.upgradeLevel} IS NULL OR ${table.upgradeLevel} IN ('patch', 'minor', 'major')`),
  publishModeCheck: check('plugin_remediation_publish_mode_check', sql`${table.publishMode} IS NULL OR ${table.publishMode} IN ('propose', 'apply')`),
  attemptCheck: check('plugin_remediation_attempt_check', sql`${table.attempt} >= 1`),
  kindCheck: check('plugin_remediation_kind_check', sql`${table.kind} IN ('plugin', 'toolchain')`),
}));

/**
 * A RustFS object / prefix (or a registry image) a purge failed to delete.
 * Never blocks the purge: the row is retried by the next purge sweep (as
 * sysadmin), counted by plugin_source_delete_failures_total and alerted on.
 * One row per (org, kind, target); a retry bumps `attempts`.
 *
 * Org-scoped and HARD-purged with the org: the org purge deletes the whole
 * `plugin-sources/<orgId>/` prefix (and image-registry its namespace) BEFORE it
 * acks, so an org's orphans are covered by that leg.
 *
 * @table plugin_source_orphans
 */
export const pluginSourceOrphan = pgTable('plugin_source_orphans', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  kind: varchar('kind', { length: 10 }).$type<PluginSourceOrphanKind>().notNull(),
  /** Bucket name for object / prefix; the image repository for image. */
  bucket: varchar('bucket', { length: 255 }).notNull(),
  /** Object key, key prefix, or image digest. */
  target: text('target').notNull(),
  pluginId: uuid('plugin_id'),
  pluginVersion: varchar('plugin_version', { length: 50 }),
  /** A short error code / S3 error name (never credentials or object contents). */
  lastError: varchar('last_error', { length: 255 }).notNull(),
  attempts: integer('attempts').default(1).notNull(),
  firstFailedAt: timestamp('first_failed_at', { withTimezone: true }).defaultNow().notNull(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  targetUnique: uniqueIndex('plugin_source_orphan_target_unique').on(table.orgId, table.kind, table.bucket, table.target),
  lastAttemptIdx: index('plugin_source_orphan_last_attempt_idx').on(table.lastAttemptAt),
  kindCheck: check('plugin_source_orphan_kind_check', sql`${table.kind} IN ('object', 'prefix', 'image')`),
}));

/**
 * An org's pluginRemediation settings (one row per org; absent = defaults —
 * read through api-core `normalizePluginRemediationSettings`). `rollout` NULL =
 * the default for the org kind (root: propose, team: inherit).
 * `allow_pipeline_apply` is read from the ROOT org's row only.
 *
 * @table plugin_remediation_settings
 */
export const pluginRemediationSetting = pgTable('plugin_remediation_settings', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  mode: varchar('mode', { length: 10 }).$type<PluginRemediationMode>().default('propose').notNull(),
  libraryUpgradeLevel: varchar('library_upgrade_level', { length: 10 }).$type<LibraryUpgradeLevel>().default('minor').notNull(),
  libraryUpgradeLevelByType: jsonb('library_upgrade_level_by_type').$type<Partial<Record<GrypePackageType, LibraryUpgradeLevel>>>().default({}).notNull(),
  libraryUpgradeLevelByPlugin: jsonb('library_upgrade_level_by_plugin').$type<Record<string, LibraryUpgradeLevel>>().default({}).notNull(),
  rollout: varchar('rollout', { length: 10 }).$type<TeamRemediationRollout>(),
  allowPipelineApply: boolean('allow_pipeline_apply').default(true).notNull(),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  modeCheck: check('plugin_remediation_settings_mode_check', sql`${table.mode} IN ('off', 'propose', 'apply')`),
  levelCheck: check('plugin_remediation_settings_level_check', sql`${table.libraryUpgradeLevel} IN ('patch', 'minor', 'major')`),
  rolloutCheck: check('plugin_remediation_settings_rollout_check', sql`${table.rollout} IS NULL OR ${table.rollout} IN ('inherit', 'off', 'propose', 'apply')`),
}));

/**
 * Stage 3, per pipeline (owned by the PIPELINE service): the proposal, the
 * wave it moved in, and its rollback. One row per (remediation, pipeline).
 * `remediation_id` is provenance (no FK: plugin_remediations is the plugin
 * service's and is purged on its own schedule).
 *
 * @table pipeline_remediation_upgrades
 */
export const pipelineRemediationUpgrade = pgTable('pipeline_remediation_upgrades', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  remediationId: uuid('remediation_id').notNull(),
  pipelineId: uuid('pipeline_id').notNull().references(() => pipeline.id, { onDelete: 'cascade' }),
  pluginName: varchar('plugin_name', { length: 255 }).notNull(),
  pluginPublisher: varchar('plugin_publisher', { length: 64 }),
  fromVersion: varchar('from_version', { length: 50 }).notNull(),
  toVersion: varchar('to_version', { length: 50 }).notNull(),
  /** The effective mode at the last resolution (resolveRemediationRollout). */
  mode: varchar('mode', { length: 10 }).$type<'off' | 'propose' | 'apply'>().notNull(),
  state: varchar('state', { length: 20 }).$type<PipelineRemediationUpgradeState>().notNull(),
  /** 0 = canary; null until it is put in a wave. */
  wave: integer('wave'),
  movedAt: timestamp('moved_at', { withTimezone: true }),
  /** The run started by the redeploy (pipeline_run_requests.id), for the 24 h rollback window. */
  runRequestId: uuid('run_request_id'),
  rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
  rolledBackTo: varchar('rolled_back_to', { length: 50 }),
  /** A short error code / user-facing message (never driver text). */
  error: varchar('error', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  remediationPipelineUnique: uniqueIndex('pipeline_remediation_upgrade_unique').on(table.remediationId, table.pipelineId),
  pipelineIdx: index('pipeline_remediation_upgrade_pipeline_idx').on(table.pipelineId, sql`${table.createdAt} DESC`),
  stateIdx: index('pipeline_remediation_upgrade_state_idx').on(table.remediationId, table.state),
  modeCheck: check('pipeline_remediation_upgrade_mode_check', sql`${table.mode} IN ('off', 'propose', 'apply')`),
  stateCheck: check('pipeline_remediation_upgrade_state_check', sql`${table.state} IN ('proposed', 'change_requested', 'queued', 'moved', 'failed', 'rolled_back', 'rollback_blocked', 'skipped_opt_out', 'skipped_runner', 'dismissed', 'superseded')`),
}));

export type PluginRemediation = typeof pluginRemediation.$inferSelect;
export type PluginRemediationInsert = typeof pluginRemediation.$inferInsert;
export type PluginSourceOrphan = typeof pluginSourceOrphan.$inferSelect;
export type PluginSourceOrphanInsert = typeof pluginSourceOrphan.$inferInsert;
export type PluginRemediationSettingRow = typeof pluginRemediationSetting.$inferSelect;
export type PluginRemediationSettingInsert = typeof pluginRemediationSetting.$inferInsert;
export type PipelineRemediationUpgrade = typeof pipelineRemediationUpgrade.$inferSelect;
export type PipelineRemediationUpgradeInsert = typeof pipelineRemediationUpgrade.$inferInsert;
