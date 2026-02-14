import { AccessModifier, ComputeType, PluginType, MetaDataType } from '@mwashburn160/api-core';
import { sql } from 'drizzle-orm';
import { boolean, varchar, pgTable, text, timestamp, uuid, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { forCreation, withUpdateTimestamp, forSoftDelete } from './helpers';

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
 * Table for storing reusable plugin configurations.
 * Plugins define the behavior of synth/build steps in CDK pipelines.
 *
 * Features:
 * - Versioning support with semantic versioning
 * - Access control via orgId and accessModifier
 * - Full audit trail (created/updated by/at)
 * - Flexible metadata storage via JSONB
 * - Support for both ShellStep and CodeBuildStep types
 *
 * @table plugins
 */
export const plugin = pgTable('plugins', {
  // Primary key
  id: uuid('id').primaryKey().defaultRandom(),

  // Organization and access control
  orgId: varchar('org_id', { length: 255 })
    .default('system')
    .notNull(),

  // Audit fields
  createdBy: text('created_by')
    .default('system')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text('updated_by')
    .default('system')
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),

  // Core plugin information
  name: varchar('name', { length: 255 })
    .notNull(),
  description: text('description'),
  keywords: jsonb('keywords')
    .$type<string[]>()
    .default([])
    .notNull(),
  version: varchar('version', { length: 50 })
    .default('1.0.0')
    .notNull(),

  // Plugin configuration
  metadata: jsonb('metadata')
    .$type<Record<string, string | number | boolean>>()
    .default({})
    .notNull(),
  pluginType: varchar('plugin_type', { length: 50 })
    .$type<PluginType>()
    .default('CodeBuildStep' as PluginType)
    .notNull(),
  computeType: varchar('compute_type', { length: 50 })
    .$type<ComputeType>()
    .default('SMALL' as ComputeType)
    .notNull(),
  primaryOutputDirectory: varchar('primary_output_directory', { length: 28 }),

  // Build configuration
  env: jsonb('env')
    .$type<Record<string, string>>()
    .default({})
    .notNull(),
  installCommands: text('install_commands')
    .array()
    .default([])
    .notNull(),
  commands: text('commands')
    .array()
    .default([])
    .notNull(),

  // Docker configuration
  imageTag: varchar('image_tag', { length: 255 })
    .notNull(),
  dockerfile: text('dockerfile'),

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
  nameIdx: index('plugin_name_idx').on(table.name),
  orgIdIdx: index('plugin_org_id_idx').on(table.orgId),
  versionIdx: index('plugin_version_idx').on(table.version),
  imageTagIdx: index('plugin_image_tag_idx').on(table.imageTag),
  activeIdx: index('plugin_active_idx').on(table.isActive),
  createdAtIdx: index('plugin_created_at_idx').on(table.createdAt),

  // Composite index for common access pattern (orgId + isActive)
  orgActiveIdx: index('plugin_org_active_idx').on(table.orgId, table.isActive),

  // Composite index for filtered queries (orgId + accessModifier)
  orgAccessIdx: index('plugin_org_access_idx').on(table.orgId, table.accessModifier),

  // Unique constraint on name + version + orgId
  nameVersionOrgUnique: uniqueIndex('plugin_name_version_org_unique')
    .on(table.name, table.version, table.orgId),

  // Check constraints
  versionCheck: check(
    'plugin_version_check',
    sql`${table.version} ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$'`,
  ),
}));

/**
 * Table for storing pipeline instances and their full configuration.
 *
 * Features:
 * - Full BuilderProps serialization for reconstruction
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
    .default('system')
    .notNull(),

  // Audit fields
  createdBy: text('created_by')
    .default('system')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text('updated_by')
    .default('system')
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

  // Composite index for common access pattern (orgId + isActive)
  orgActiveIdx: index('pipeline_org_active_idx').on(table.orgId, table.isActive),

  // Composite index for filtered queries (orgId + accessModifier)
  orgAccessIdx: index('pipeline_org_access_idx').on(table.orgId, table.accessModifier),

  // Unique constraint on project + organization + orgId
  projectOrgUnique: uniqueIndex('pipeline_project_org_unique')
    .on(table.project, table.organization, table.orgId),
}));

/**
 * Complete Drizzle schema export
 */
export const schema = {
  plugin,
  pipeline,
} as const;

/**
 * TypeScript types representing database rows
 */
export type Plugin = typeof plugin.$inferSelect;
export type PluginInsert = typeof plugin.$inferInsert;

export type Pipeline = typeof pipeline.$inferSelect;
export type PipelineInsert = typeof pipeline.$inferInsert;

/**
 * Helper types for working with partial updates
 */
export type PluginUpdate = Partial<Omit<PluginInsert, 'id' | 'createdAt' | 'createdBy'>>;
export type PipelineUpdate = Partial<Omit<PipelineInsert, 'id' | 'createdAt' | 'createdBy'>>;

/**
 * Helper function to create a new plugin with timestamps.
 * Uses the generic forCreation helper.
 */
export function createPlugin(data: Omit<PluginInsert, 'id' | 'createdAt' | 'updatedAt'>): PluginInsert {
  return forCreation<PluginInsert>(data) as PluginInsert;
}

/**
 * Helper function to create a new pipeline with timestamps.
 * Uses the generic forCreation helper.
 */
export function createPipeline(data: Omit<PipelineInsert, 'id' | 'createdAt' | 'updatedAt'>): PipelineInsert {
  return forCreation<PipelineInsert>(data) as PipelineInsert;
}

/**
 * Helper function to update plugin timestamp.
 * Uses the generic withUpdateTimestamp helper.
 */
export function updatePluginTimestamp(updates: PluginUpdate, updatedBy: string): PluginUpdate {
  return withUpdateTimestamp<PluginUpdate>(updates, updatedBy);
}

/**
 * Helper function to update pipeline timestamp.
 * Uses the generic withUpdateTimestamp helper.
 */
export function updatePipelineTimestamp(updates: PipelineUpdate, updatedBy: string): PipelineUpdate {
  return withUpdateTimestamp<PipelineUpdate>(updates, updatedBy);
}

/**
 * Helper function for soft deleting a plugin.
 * Uses the generic forSoftDelete helper.
 */
export function softDeletePlugin(deletedBy: string): PluginUpdate {
  return forSoftDelete<PluginUpdate>(deletedBy);
}

/**
 * Helper function for soft deleting a pipeline.
 * Uses the generic forSoftDelete helper.
 */
export function softDeletePipeline(deletedBy: string): PipelineUpdate {
  return forSoftDelete<PipelineUpdate>(deletedBy);
}