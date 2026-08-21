// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AccessModifier, SYSTEM_ORG_ID, type Criticality, type EntityLabels, type EntityLink, type Lifecycle, type MetaDataType, type OwnerType } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, varchar, pgTable, text, timestamp, uuid, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Pipeline builder configuration properties stored in database.
 * Mirrors the canonical BuilderProps from pipeline-core (JSON-serializable form).
 */
export interface PipelineBuilderConfig {
  readonly project: string;
  readonly organization: string;
  readonly pipelineName?: string;
  readonly global?: MetaDataType;
  readonly synth: Record<string, unknown>;
  readonly defaults?: Record<string, unknown>;
  readonly role?: Record<string, unknown>;
  readonly stages?: PipelineStageConfig[];
}

/**
 * Stage configuration stored in database (JSON-serializable).
 */
export interface PipelineStageConfig {
  readonly stageName: string;
  readonly alias?: string;
  readonly steps: Record<string, unknown>[];
}

/**
 * Table for storing pipeline instances and their full configuration.
 *
 * Features * - Full BuilderProps serialization for reconstruction
 * - Organization-level isolation
 * - Pipeline status tracking
 * - Execution history tracking
 * - Flexible tagging system
 *
 * @table pipelines
 */
export const pipeline = pgTable('pipelines', {
  // Primary key
  id: uuid('id').primaryKey().defaultRandom(),

  // Organization and access control
  orgId: varchar('org_id', { length: 255 })
    .default(SYSTEM_ORG_ID)
    .notNull(),

  // Audit fields
  createdBy: text('created_by')
    .default(SYSTEM_ORG_ID)
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text('updated_by')
    .default(SYSTEM_ORG_ID)
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),

  // Core pipeline information
  project: varchar('project', { length: 255 })
    .notNull(),
  organization: varchar('organization', { length: 255 })
    .notNull(),
  pipelineName: varchar('pipeline_name', { length: 255 }),
  description: text('description'),
  keywords: jsonb('keywords')
    .$type<string[]>()
    .default([])
    .notNull(),

  // Pipeline configuration
  props: jsonb('props')
    .$type<PipelineBuilderConfig>()
    .notNull(),

  // Developer-portal catalog metadata (ownership / lifecycle / classification).
  // ownerId defaults to the creating user (set at insert), so every pipeline has
  // an owner for "my services" views; ownerType distinguishes user vs team.
  ownerId: text('owner_id'),
  ownerType: varchar('owner_type', { length: 10 }).$type<OwnerType>(),
  lifecycle: varchar('lifecycle', { length: 20 })
    .$type<Lifecycle>()
    .default('production' as Lifecycle)
    .notNull(),
  criticality: varchar('criticality', { length: 10 }).$type<Criticality>(),
  labels: jsonb('labels')
    .$type<EntityLabels>()
    .default({})
    .notNull(),
  links: jsonb('links')
    .$type<EntityLink[]>()
    .default([])
    .notNull(),

  // Access and visibility
  accessModifier: varchar('access_modifier', { length: 10 })
    .$type<AccessModifier>()
    .default('private' as AccessModifier)
    .notNull(),
  isDefault: boolean('is_default')
    .default(false)
    .notNull(),
  isActive: boolean('is_active')
    .default(true)
    .notNull(),

  // Deletion tracking (soft delete)
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  // Soft-delete purge deadline: the retention sweep hard-deletes tombstoned
  // rows once `purge_after` has passed (set on delete alongside deleted_at).
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
}, (table) => ({
  // Partial index over just the tombstones — drives the retention purge sweep
  // (`WHERE deleted_at IS NOT NULL AND purge_after < now`) without scanning live rows.
  purgeIdx: index('pipeline_purge_idx').on(table.purgeAfter).where(sql`deleted_at IS NOT NULL`),
  // Indexes for common queries
  projectIdx: index('pipeline_project_idx').on(table.project),
  // Developer-portal catalog indexes: "my services" (owner) + lifecycle filter.
  ownerIdx: index('pipeline_owner_idx').on(table.orgId, table.ownerId),
  lifecycleIdx: index('pipeline_lifecycle_idx').on(table.orgId, table.lifecycle),
  organizationIdx: index('pipeline_organization_idx').on(table.organization),
  orgIdIdx: index('pipeline_org_id_idx').on(table.orgId),
  activeIdx: index('pipeline_active_idx').on(table.isActive),
  createdAtIdx: index('pipeline_created_at_idx').on(table.createdAt),
  updatedAtIdx: index('pipeline_updated_at_idx').on(table.updatedAt),

  // Composite index for common access pattern (orgId + isActive)
  orgActiveIdx: index('pipeline_org_active_idx').on(table.orgId, table.isActive),

  // Composite index for filtered queries (orgId + accessModifier + isActive)
  orgAccessActiveIdx: index('pipeline_org_access_active_idx').on(table.orgId, table.accessModifier, table.isActive),

  // Partial index for active-only queries (smaller, faster than full index)
  activeOnlyOrgIdx: index('pipeline_active_only_org_idx').on(table.orgId, table.createdAt).where(sql`is_active = true`),

  // Unique constraint on project + organization + orgId
  projectOrgUnique: uniqueIndex('pipeline_project_org_unique')
    .on(table.project, table.organization, table.orgId),
}));

/**
 * Pipeline deployment registry.
 * Maps deployed CodePipeline ARNs back to pipeline records and org IDs.
 * Populated by the deploy command after successful CDK deploy.
 * Used by the pipeline-events Lambda to resolve EventBridge events to org-scoped records.
 *
 * @table pipeline_registry
 */
export const pipelineRegistry = pgTable('pipeline_registry', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The platform's pipeline record id — a STABLE uuid created with the pipeline
  // record, known at CDK synth, and applied to the live CodePipeline as the
  // `pb.pipeline-id` tag. The events Lambda reads that tag and reports
  // against this id, so it IS the event join key (replacing the masked ARN —
  // it carries no AWS account/region, so no masking is needed). Unique: one
  // registry row per pipeline + the upsert key for (re)registration.
  pipelineId: uuid('pipeline_id').notNull().unique(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pipelineName: varchar('pipeline_name', { length: 255 }).notNull(),
  region: varchar('region', { length: 30 }),
  project: varchar('project', { length: 255 }),
  organization: varchar('organization', { length: 255 }),
  lastDeployed: timestamp('last_deployed', { withTimezone: true }),
  stackName: varchar('stack_name', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('registry_org_id_idx').on(table.orgId),
  orgRegionIdx: index('registry_org_region_idx').on(table.orgId, table.region),
}));

/**
 * Event source identifiers for pipeline_events.
 */
export type EventSource = 'codepipeline' | 'codebuild' | 'plugin-build';

/**
 * Event type granularity levels for pipeline_events.
 */
export type EventType = 'PIPELINE' | 'STAGE' | 'ACTION' | 'BUILD';

/**
 * Pipeline execution and build events.
 * Captures CodePipeline/CodeBuild state changes from EventBridge
 * and plugin Docker build outcomes from BullMQ.
 * All events are org-scoped for multi-tenant reporting.
 *
 * @table pipeline_events
 */
export const pipelineEvent = pgTable('pipeline_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  pipelineId: uuid('pipeline_id'),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  eventSource: varchar('event_source', { length: 50 }).$type<EventSource>().notNull(),
  eventType: varchar('event_type', { length: 50 }).$type<EventType>().notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  executionId: varchar('execution_id', { length: 255 }),
  stageName: varchar('stage_name', { length: 255 }),
  actionName: varchar('action_name', { length: 255 }),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  // DORA deploy-attribution (all nullable; populated at ingest when the source
  // event carries them — legacy/CI-only events leave them NULL). `environment`
  // is the deploy target (e.g. "production"); its presence marks an execution
  // as a real deployment, letting DORA scope past generic pipeline runs.
  // `commitSha`/`commitRef` capture the source revision for lead-time work.
  commitSha: varchar('commit_sha', { length: 255 }),
  commitRef: varchar('commit_ref', { length: 255 }),
  environment: varchar('environment', { length: 255 }),
  // DORA true-lead-time attribution (Phase 4). The forwarder resolves the source
  // commit range in-account and reports the OLDEST unshipped commit's timestamp
  // + how many commits shipped. Both nullable — events whose source type/token
  // can't be resolved leave them NULL and lead time reports `unknown`.
  commitTimestamp: timestamp('commit_timestamp', { withTimezone: true }),
  commitCount: integer('commit_count'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pipelineIdIdx: index('event_pipeline_id_idx').on(table.pipelineId),
  orgIdIdx: index('event_org_id_idx').on(table.orgId),
  eventTypeIdx: index('event_type_idx').on(table.eventType),
  statusIdx: index('event_status_idx').on(table.status),
  executionIdIdx: index('event_execution_id_idx').on(table.executionId),
  createdAtIdx: index('event_created_at_idx').on(table.createdAt),
  orgTypeCreatedIdx: index('event_org_type_created_idx').on(table.orgId, table.eventType, table.createdAt),
  orgSourceStatusIdx: index('event_org_source_status_idx').on(table.orgId, table.eventSource, table.status),
  // Idempotency: EventBridge → SQS is at-least-once, so the same state-change
  // can be delivered twice. This partial unique index dedups re-deliveries
  // (paired with `onConflictDoNothing` in reporting-service.ingestEvents).
  // Partial (execution_id IS NOT NULL) because that's the natural per-event
  // key; events without an executionId (rare) aren't deduped, which is safe.
  // Includes pipeline_id so a (theoretical) execution-id reuse across pipelines
  // can't collide now that the ARN is no longer part of the row.
  //
  // COALESCE the nullable parts to sentinels (expression index): PIPELINE/STAGE/
  // BUILD events leave stage_name/action_name NULL (plugin-build also pipeline_id
  // NULL), and Postgres treats NULLs as DISTINCT in a unique index — so the plain
  // column index never matches for those types and onConflictDoNothing can't dedup
  // their at-least-once re-deliveries. Collapsing NULL→'' makes equal events equal.
  // (drizzle's uniqueIndex can't express NULLS NOT DISTINCT on a partial index, so
  // we use the equivalent expression index.) MIGRATION REQUIRED: drizzle-kit generate.
  dedupIdx: uniqueIndex('event_dedup_idx')
    .on(
      sql`coalesce(${table.pipelineId}::text, '')`,
      table.executionId,
      table.eventType,
      table.status,
      sql`coalesce(${table.stageName}, '')`,
      sql`coalesce(${table.actionName}, '')`,
    )
    .where(sql`execution_id IS NOT NULL`),
  // DORA deploy-scoped reads: only PIPELINE-level executions tagged with a
  // deploy environment. `event_type` is in the index because the events Lambda
  // tags EVERY event of a deployed pipeline (STAGE/ACTION too), while the DORA
  // scan wants only `event_type='PIPELINE'` — including it restores selectivity.
  // Partial (environment IS NOT NULL) keeps it small — legacy/CI-only events
  // aren't indexed. The default run-based DORA path (no environment) can't use
  // this partial index; it relies on event_pipeline_type_started_idx below.
  // MIGRATION REQUIRED: drizzle-kit generate.
  envTypeStartedIdx: index('event_env_type_started_idx')
    .on(table.environment, table.eventType, table.startedAt)
    .where(sql`environment IS NOT NULL`),
  // started_at range scans: every Category-1 report and the default run-based
  // DORA path filters `event_type='PIPELINE' AND started_at BETWEEN …` joined on
  // pipeline_id, but the other event composite index is on created_at, not
  // started_at — so the range scan had no ideal index. This composite serves the
  // join-driven scan by pipeline_id. MIGRATION REQUIRED: drizzle-kit generate.
  pipelineTypeStartedIdx: index('event_pipeline_type_started_idx')
    .on(table.pipelineId, table.eventType, table.startedAt),
  // DORA deploy-basis scan (Phase 1): deployment frequency / deploy-time CFR /
  // lead time all group deploy-stage events by environment over a completed_at
  // window. This composite serves that grouped org-scoped scan directly.
  // MIGRATION REQUIRED: drizzle-kit generate.
  orgEnvCompletedIdx: index('event_org_env_completed_idx')
    .on(table.orgId, table.environment, table.completedAt),
}));

/**
 * Manual post-deploy outcome markers (Phase 2). A user marks a deployment
 * `failed` (production incident linked to a deploy) or `restored` (recovered).
 * These feed the DORA post-deploy Change Failure Rate component and the real
 * MTTR (restored − deployed). Correlated to a deploy execution by `executionId`.
 *
 * @table deployment_outcomes
 */
export const deploymentOutcome = pgTable('deployment_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  executionId: varchar('execution_id', { length: 255 }).notNull(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  environment: varchar('environment', { length: 255 }),
  outcome: varchar('outcome', { length: 20 }).$type<'failed' | 'restored'>().notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgEnvIdx: index('deployment_outcomes_org_env_idx').on(table.orgId, table.environment),
  executionIdx: index('deployment_outcomes_execution_idx').on(table.executionId),
  // Idempotent re-marking: one row per (execution, outcome). Re-posting the same
  // outcome for a deploy is a no-op/refresh (onConflictDoUpdate the `at`), so a
  // failed→restored pair is two rows while a duplicate POST doesn't double-count.
  executionOutcomeUnique: uniqueIndex('deployment_outcomes_execution_outcome_unique')
    .on(table.executionId, table.outcome),
}));

/**
 * Per-org ingestion health (Phase 3). The AWS events Lambda periodically posts
 * forwarded/dropped counters + the last event timestamp so the Reports UI can
 * show whether events are flowing / stale / dropping. One row per org.
 *
 * @table ingest_health
 */
export const ingestHealth = pgTable('ingest_health', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  forwarded: bigint('forwarded', { mode: 'number' }),
  dropped: bigint('dropped', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Production incidents ingested from the org's incident tooling (Phase 5). The
 * user points their Alertmanager / PagerDuty / Datadog webhook at
 * `POST /api/reports/incidents` (machine `reporting:ingest` scope). Each incident
 * carries its external id, the affected `environment`, when it opened, and when
 * it was resolved (nullable — a later resolve updates it). DORA correlates each
 * incident to the most recent successful deploy to `environment` within
 * `DORA_INCIDENT_WINDOW_HOURS`, turning it into an automated post-deploy failure
 * (Change Failure Rate) and a real recovery time (`resolved_at − opened_at` MTTR).
 * `incident_id` is UNIQUE per org so a resolve re-post is an idempotent upsert.
 *
 * @table incidents
 */
export const incident = pgTable('incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  // External incident id from the source system (PagerDuty/Datadog/Alertmanager).
  // Unique PER ORG (see incidentOrgUnique) — the idempotency + upsert key.
  incidentId: varchar('incident_id', { length: 255 }).notNull(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  // Affected deploy environment (e.g. "production"). Correlated to a deploy env.
  environment: varchar('environment', { length: 255 }).notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  // NULL while the incident is open; a later resolve webhook sets it (idempotent
  // upsert). `resolved_at − opened_at` is the real MTTR for the correlated deploy.
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  severity: varchar('severity', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // Correlation scan: most-recent-deploy-before-open lookups group by (org, env)
  // and range on opened_at.
  orgEnvOpenedIdx: index('incidents_org_env_opened_idx').on(table.orgId, table.environment, table.openedAt),
  // Idempotent upsert / dedup: one row per (org, incident_id). A resolve re-post
  // updates resolved_at instead of inserting a duplicate.
  orgIncidentUnique: uniqueIndex('incidents_org_incident_unique').on(table.orgId, table.incidentId),
}));

/**
 * Per-org DORA computation + retention overrides. One row per org (org_id PK).
 * `incidentWindowHours` (Phase 5b) overrides the global `DORA_INCIDENT_WINDOW_HOURS`
 * used to correlate an ingested incident to the most recent successful deploy.
 * `eventRetentionDays` / `doraRetentionDays` (Phase 7) override the global reporting
 * retention windows for the split sweep — standard events (`environment IS NULL`)
 * vs DORA source (deploy stages + `deployment_outcomes` + `incidents`). Any NULL /
 * absent value falls back to its env default. Set self-serve by an org admin via
 * `PUT /api/reports/settings/incidents`. This table is itself never purged.
 *
 * @table dora_settings
 */
export const doraSettings = pgTable('dora_settings', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  incidentWindowHours: integer('incident_window_hours'),
  // Phase 7 retention overrides (days). NULL ⇒ use the global env default
  // (REPORTING_EVENT_RETENTION_DAYS / REPORTING_DORA_RETENTION_DAYS).
  eventRetentionDays: integer('event_retention_days'),
  doraRetentionDays: integer('dora_retention_days'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * TypeScript types representing database rows
 */
export type Pipeline = typeof pipeline.$inferSelect;
export type PipelineInsert = typeof pipeline.$inferInsert;

export type PipelineRegistry = typeof pipelineRegistry.$inferSelect;
export type PipelineRegistryInsert = typeof pipelineRegistry.$inferInsert;

export type PipelineEvent = typeof pipelineEvent.$inferSelect;
export type PipelineEventInsert = typeof pipelineEvent.$inferInsert;

export type DeploymentOutcome = typeof deploymentOutcome.$inferSelect;
export type DeploymentOutcomeInsert = typeof deploymentOutcome.$inferInsert;

export type IngestHealth = typeof ingestHealth.$inferSelect;
export type IngestHealthInsert = typeof ingestHealth.$inferInsert;

export type Incident = typeof incident.$inferSelect;
export type IncidentInsert = typeof incident.$inferInsert;

export type DoraSettings = typeof doraSettings.$inferSelect;
export type DoraSettingsInsert = typeof doraSettings.$inferInsert;

/**
 * Helper types for working with partial updates
 */
export type PipelineUpdate = Partial<Omit<PipelineInsert, 'id' | 'createdAt' | 'createdBy'>>;
