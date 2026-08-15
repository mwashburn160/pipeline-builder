// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AccessModifier, ComputeType, PluginType, SYSTEM_ORG_ID, type Criticality, type EntityLabels, type EntityLink, type Lifecycle, type OwnerType } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { boolean, integer, varchar, pgTable, text, timestamp, uuid, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';

/**
 * Secret requirement for a plugin.
 * Declares named secrets the plugin expects at build time.
 */
export interface PluginSecret {
  name: string;
  required: boolean;
  description?: string;
}

/**
 * Table for storing reusable plugin configurations.
 * Plugins define the behavior of synth/build steps in CDK pipelines.
 *
 * Features * - Versioning support with semantic versioning
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

  // Plugin classification
  category: varchar('category', { length: 50 })
    .default('unknown')
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
  timeout: integer('timeout'),
  failureBehavior: varchar('failure_behavior', { length: 10 })
    .$type<'fail' | 'warn' | 'ignore'>()
    .default('fail')
    .notNull(),
  secrets: jsonb('secrets')
    .$type<PluginSecret[]>()
    .default([])
    .notNull(),
  primaryOutputDirectory: varchar('primary_output_directory', { length: 28 }),

  // Build configuration
  env: jsonb('env')
    .$type<Record<string, string>>()
    .default({})
    .notNull(),
  buildArgs: jsonb('build_args')
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
  dockerfile: text('dockerfile'),
  buildType: varchar('build_type', { length: 20 })
    .default('build_image')
    .notNull(),

  // Developer-portal catalog metadata (ownership / lifecycle / classification).
  // ownerId defaults to the creating user (set at insert), so every plugin has
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
  // Partial index over just the tombstones — drives the retention purge sweep.
  purgeIdx: index('plugin_purge_idx').on(table.purgeAfter).where(sql`deleted_at IS NOT NULL`),
  // Indexes for common queries
  nameIdx: index('plugin_name_idx').on(table.name),
  orgIdIdx: index('plugin_org_id_idx').on(table.orgId),
  versionIdx: index('plugin_version_idx').on(table.version),
  activeIdx: index('plugin_active_idx').on(table.isActive),
  createdAtIdx: index('plugin_created_at_idx').on(table.createdAt),
  updatedAtIdx: index('plugin_updated_at_idx').on(table.updatedAt),

  // Category index for filtering
  categoryIdx: index('plugin_category_idx').on(table.category),

  // Developer-portal catalog indexes: "my services" (owner) + lifecycle filter.
  ownerIdx: index('plugin_owner_idx').on(table.orgId, table.ownerId),
  lifecycleIdx: index('plugin_lifecycle_idx').on(table.orgId, table.lifecycle),

  // Composite index for common access pattern (orgId + isActive)
  orgActiveIdx: index('plugin_org_active_idx').on(table.orgId, table.isActive),

  // Composite index for filtered queries (orgId + accessModifier + isActive)
  orgAccessActiveIdx: index('plugin_org_access_active_idx').on(table.orgId, table.accessModifier, table.isActive),

  // Partial index for active-only queries (smaller, faster than full index)
  activeOnlyOrgIdx: index('plugin_active_only_org_idx').on(table.orgId, table.createdAt).where(sql`is_active = true`),

  // Unique constraint on name + version + orgId
  nameVersionOrgUnique: uniqueIndex('plugin_name_version_org_unique')
    .on(table.name, table.version, table.orgId),

  // Check constraints
  versionCheck: check( 'plugin_version_check',
    sql`${table.version} ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$'`,
  ),
}));

/**
 * TypeScript types representing database rows
 */
export type Plugin = typeof plugin.$inferSelect;
export type PluginInsert = typeof plugin.$inferInsert;

/**
 * Helper types for working with partial updates
 */
export type PluginUpdate = Partial<Omit<PluginInsert, 'id' | 'createdAt' | 'createdBy'>>;
