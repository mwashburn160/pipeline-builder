// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ComputeType, PluginType, SYSTEM_ORG_ID, type Criticality, type EntityLabels, type EntityLink, type Lifecycle,
  type MetadataSources, type OwnerType, type Visibility,
} from '@pipeline-builder/api-core';
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
 * Where a plugin's image came from: `built` by the platform's BuildKit (carries
 * SLSA provenance) or `uploaded` as a prebuilt `image.tar` (SBOM + signature
 * only — the platform never saw the build).
 */
export type ImageSource = 'built' | 'uploaded';

/**
 * Plugin lifecycle: the shared catalog {@link Lifecycle} plus `yanked`, which
 * only plugin versions can reach (a yanked version stops resolving for new
 * synths). `yankedAt` / `deprecatedAt` are the authoritative timestamps; the
 * lifecycle value mirrors them for catalog filtering.
 */
export type PluginLifecycle = Lifecycle | 'yanked';

/** Coercion type a `requiredMetadata` / `requiredVars` key is declared as. */
export type PluginContractValueType = 'string' | 'number' | 'bool' | 'json';

/**
 * The spec's smoke-test declaration. Today a bare command string; stored as
 * JSONB so a structured form can follow without another column.
 */
export type PluginSmokeTest = string | Record<string, unknown>;

/** A curated icon (§6a.1): a key into the curated set, plus an optional badge. */
export interface PluginIcon {
  key: string;
  badge?: string;
}

/**
 * Storage keys of an uploaded icon's re-encoded WebP renditions (image-registry
 * decodes + re-encodes every upload; the raw file and SVG are never stored).
 */
export interface PluginUploadedIcon {
  key256: string;
  key64: string;
}

/**
 * Table for storing reusable plugin configurations.
 * Plugins define the behavior of synth/build steps in CDK pipelines.
 *
 * Features * - Versioning support with semantic versioning
 * - Access control via orgId and the three-rung `visibility` ladder
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

  // Spec contract, persisted (not just validated at upload): the
  // `{{ pipeline.metadata.X }}` / `{{ pipeline.vars.X }}` keys a pipeline must
  // supply, their declared coercion types, the smoke test, and the declared
  // outbound hostnames (spec `network.egress`) shown to consumers.
  requiredMetadata: jsonb('required_metadata')
    .$type<string[]>()
    .default([])
    .notNull(),
  requiredVars: jsonb('required_vars')
    .$type<string[]>()
    .default([])
    .notNull(),
  metadataTypes: jsonb('metadata_types')
    .$type<Record<string, PluginContractValueType>>()
    .default({})
    .notNull(),
  varsTypes: jsonb('vars_types')
    .$type<Record<string, PluginContractValueType>>()
    .default({})
    .notNull(),
  smokeTest: jsonb('smoke_test').$type<PluginSmokeTest>(),
  networkEgress: jsonb('network_egress')
    .$type<string[]>()
    .default([])
    .notNull(),

  // Documentation. The README is kept as source markdown AND pre-sanitized
  // HTML (rendered once at upload), so no read path renders untrusted markdown.
  readmeMd: text('readme_md'),
  readmeHtml: text('readme_html'),
  // SPDX license identifier.
  license: varchar('license', { length: 64 }),
  changelog: text('changelog'),
  homepageUrl: varchar('homepage_url', { length: 2048 }),
  sourceUrl: varchar('source_url', { length: 2048 }),
  icon: jsonb('icon').$type<PluginIcon>(),
  uploadedIcon: jsonb('uploaded_icon').$type<PluginUploadedIcon>(),

  // Catalog metadata (§3.1a, D19): detected from the package (spec, README,
  // the plugin's own Dockerfile OCI labels), then accepted or edited by the
  // user. `summary` is the card one-liner (G53); `displayName` falls back to
  // `name` when unset. `metadataSources` records, per descriptive field, where
  // its value came from (`spec | readme | dockerfile | derived | user`) so a
  // reviewer can see what was typed rather than shipped in the package.
  summary: varchar('summary', { length: 160 }),
  displayName: varchar('display_name', { length: 100 }),
  documentationUrl: varchar('documentation_url', { length: 2048 }),
  metadataSources: jsonb('metadata_sources')
    .$type<MetadataSources>()
    .default({})
    .notNull(),

  // Docker configuration
  dockerfile: text('dockerfile'),
  buildType: varchar('build_type', { length: 20 })
    .default('build_image')
    .notNull(),

  // Supply chain. Set by the build worker once the image is pushed, signed and
  // carries its SBOM attestation; NULL for plugins that produce no image
  // (metadata_only, approval steps). `imageDigest` is what synth pins CodeBuild
  // to (`<repo>@sha256:…`) — never the mutable `name:version` tag.
  // `imageSource` separates an image this platform BUILT (BuildKit provenance
  // attached) from an UPLOADED `image.tar` whose build it never saw.
  imageDigest: varchar('image_digest', { length: 71 }),
  imageSource: varchar('image_source', { length: 10 }).$type<ImageSource>(),

  // Vulnerability scan (grype over the SBOM at build; nightly rescan) and the
  // image's effective USER. NULL = not scanned / produces no image.
  vulnCritical: integer('vuln_critical'),
  vulnHigh: integer('vuln_high'),
  vulnMedium: integer('vuln_medium'),
  vulnLow: integer('vuln_low'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }),
  runAsRoot: boolean('run_as_root'),

  // Version lifecycle. `breaking`: a publisher-marked major that `latest`
  // installs never cross without re-approval. `frozenAt`: set the moment a
  // publish request references this version — re-uploading it is then refused
  // (409, §3.4). Yank / deprecation carry their reason alongside the timestamp.
  breaking: boolean('breaking')
    .default(false)
    .notNull(),
  frozenAt: timestamp('frozen_at', { withTimezone: true }),
  yankedAt: timestamp('yanked_at', { withTimezone: true }),
  yankReason: text('yank_reason'),
  deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
  deprecationMessage: text('deprecation_message'),

  // Developer-portal catalog metadata (ownership / lifecycle / classification).
  // ownerId defaults to the creating user (set at insert), so every plugin has
  // an owner for "my services" views; ownerType distinguishes user vs team.
  ownerId: text('owner_id'),
  ownerType: varchar('owner_type', { length: 10 }).$type<OwnerType>(),
  lifecycle: varchar('lifecycle', { length: 20 })
    .$type<PluginLifecycle>()
    .default('production' as PluginLifecycle)
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

  // Access and visibility — the shared three-rung ladder (see api-core's
  // `Visibility`): `private` is author-only (`created_by`), `org` is the whole
  // owning org, `public` reaches the org's teams and — from the system org —
  // every org. Constrained at the SQL layer too via a CHECK in postgres-init.sql
  // so a typo can't sneak past the application layer.
  visibility: varchar('visibility', { length: 10 })
    .$type<Visibility>()
    .default('private')
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

  // The quota period (`resetAt`) this version's `plugins` slot was charged to
  // at upload; NULL when no slot was charged (system catalog loads) or it was
  // already refunded. A delete/purge refunds CONDITIONALLY on it (the quota
  // service ignores the refund once that period has rolled over), then clears it.
  quotaResetAt: timestamp('quota_reset_at', { withTimezone: true }),
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

  // Composite index for filtered queries (orgId + visibility + isActive)
  orgVisibilityActiveIdx: index('plugin_org_visibility_active_idx').on(table.orgId, table.visibility, table.isActive),
  // Drives the "my private drafts" leg of the visibility predicate.
  createdByIdx: index('plugin_created_by_idx').on(table.orgId, table.createdBy),

  // Partial index for active-only queries (smaller, faster than full index)
  activeOnlyOrgIdx: index('plugin_active_only_org_idx').on(table.orgId, table.createdAt).where(sql`is_active = true`),

  // Unique constraint on name + version + orgId
  nameVersionOrgUnique: uniqueIndex('plugin_name_version_org_unique')
    .on(table.name, table.version, table.orgId),

  // Check constraints
  versionCheck: check( 'plugin_version_check',
    sql`${table.version} ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$'`,
  ),
  imageDigestCheck: check('plugin_image_digest_check',
    sql`${table.imageDigest} IS NULL OR ${table.imageDigest} ~ '^sha256:[0-9a-f]{64}$'`,
  ),
  imageSourceCheck: check('plugin_image_source_check',
    sql`${table.imageSource} IS NULL OR ${table.imageSource} IN ('built', 'uploaded')`,
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
