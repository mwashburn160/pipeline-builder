// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AccessModifier, SYSTEM_ORG_ID, type MetaDataType } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { boolean, integer, varchar, pgTable, text, timestamp, uuid, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

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
}, (table) => ({
  // Indexes for common queries
  projectIdx: index('pipeline_project_idx').on(table.project),
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
  // `PIPELINE_EVENT_ID` tag. The events Lambda reads that tag and reports
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
}));

/**
 * TypeScript types representing database rows
 */
export type Pipeline = typeof pipeline.$inferSelect;
export type PipelineInsert = typeof pipeline.$inferInsert;

export type PipelineRegistry = typeof pipelineRegistry.$inferSelect;
export type PipelineRegistryInsert = typeof pipelineRegistry.$inferInsert;

export type PipelineEvent = typeof pipelineEvent.$inferSelect;
export type PipelineEventInsert = typeof pipelineEvent.$inferInsert;

/**
 * Helper types for working with partial updates
 */
export type PipelineUpdate = Partial<Omit<PipelineInsert, 'id' | 'createdAt' | 'createdBy'>>;
