// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_ORG_ID,
  type Criticality,
  type EntityLabels,
  type EntityLink,
  type Lifecycle,
  type OwnerType,
  type TemplateInput,
  type Visibility,
} from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { boolean, varchar, pgTable, text, timestamp, uuid, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Golden-path pipeline templates. A template is a parameterized starter: its
 * `props` is a BuilderProps body with `{{ vars.* }}` placeholders, and `inputs`
 * declares the variables a developer fills in when instantiating it into a real
 * pipeline. System-org public templates form the shared golden-path catalog
 * (visible to every org, same pattern as the sample template catalog / compliance templates).
 *
 * Visibility ladder (three rungs, like `dashboards` — NOT the catalog-wide
 * three-value `visibility` that pipelines/plugins carry):
 * - `private` — only the author (`created_by`) can read/write it; a personal draft
 * - `org`     — anyone in the owning org can read it; `pipelines:write` edits it
 * - `public`  — shared beyond the org: a team also sees its parent org's public
 *               templates, and the system org's public templates are the shared
 *               golden-path catalog every org sees. Needs `pipelines:publish`.
 * The read predicate lives in `buildPipelineTemplateConditions`; the write gate
 * in api-core's `requireTemplateWriteAccess`.
 *
 * @table pipeline_templates
 */
export const pipelineTemplate = pgTable('pipeline_templates', {
  id: uuid('id').primaryKey().defaultRandom(),

  orgId: varchar('org_id', { length: 255 }).default(SYSTEM_ORG_ID).notNull(),

  // Audit
  createdBy: text('created_by').default(SYSTEM_ORG_ID).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').default(SYSTEM_ORG_ID).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

  // Core template information
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  keywords: jsonb('keywords').$type<string[]>().default([]).notNull(),
  category: varchar('category', { length: 50 }).default('general').notNull(),

  // Template body: a BuilderProps with `{{ vars.* }}` placeholders. Typed loosely
  // because a template may omit concrete project/organization until instantiated.
  props: jsonb('props').$type<Record<string, unknown>>().notNull(),
  // Declared inputs (the `vars.*` contract a developer fills in to instantiate).
  inputs: jsonb('inputs').$type<TemplateInput[]>().default([]).notNull(),

  // Developer-portal catalog metadata (ownership / lifecycle / classification)
  ownerId: text('owner_id'),
  ownerType: varchar('owner_type', { length: 10 }).$type<OwnerType>(),
  lifecycle: varchar('lifecycle', { length: 20 }).$type<Lifecycle>().default('production' as Lifecycle).notNull(),
  criticality: varchar('criticality', { length: 10 }).$type<Criticality>(),
  labels: jsonb('labels').$type<EntityLabels>().default({}).notNull(),
  links: jsonb('links').$type<EntityLink[]>().default([]).notNull(),

  // Access and visibility — see the header for the ladder. Constrained at the
  // SQL layer too via a CHECK in postgres-init.sql so a typo can't sneak past
  // the application layer.
  visibility: varchar('visibility', { length: 10 })
    .$type<Visibility>()
    .default('private')
    .notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),

  // Soft delete
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  // Soft-delete purge deadline: the retention sweep hard-deletes tombstoned
  // rows once `purge_after` has passed (set on delete alongside deleted_at).
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
}, (table) => ({
  // Partial index over just the tombstones — drives the retention purge sweep.
  purgeIdx: index('pipeline_template_purge_idx').on(table.purgeAfter).where(sql`deleted_at IS NOT NULL`),
  orgIdIdx: index('pipeline_template_org_id_idx').on(table.orgId),
  activeIdx: index('pipeline_template_active_idx').on(table.isActive),
  categoryIdx: index('pipeline_template_category_idx').on(table.category),
  // Listing is org-scoped, visibility-filtered and active-only, so all three go in.
  orgVisibilityActiveIdx: index('pipeline_template_org_visibility_active_idx').on(table.orgId, table.visibility, table.isActive),
  // Drives the "my private drafts" leg of the visibility predicate.
  createdByIdx: index('pipeline_template_created_by_idx').on(table.orgId, table.createdBy),
  ownerIdx: index('pipeline_template_owner_idx').on(table.orgId, table.ownerId),
  lifecycleIdx: index('pipeline_template_lifecycle_idx').on(table.orgId, table.lifecycle),
  // One template name per org.
  nameOrgUnique: uniqueIndex('pipeline_template_name_org_unique').on(table.name, table.orgId),
}));

export type PipelineTemplate = typeof pipelineTemplate.$inferSelect;
export type PipelineTemplateInsert = typeof pipelineTemplate.$inferInsert;
export type PipelineTemplateUpdate = Partial<Omit<PipelineTemplateInsert, 'id' | 'createdAt' | 'createdBy'>>;
