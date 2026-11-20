// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ComputeType, PluginType, SYSTEM_ORG_ID, type Criticality, type EntityLabels, type EntityLink,
  type ImageSource, type MetadataSources, type OwnerType, type PluginContractValueType, type PluginIcon,
  type PluginLifecycle, type PluginRecord, type PluginScanFlag, type PluginScanSummary, type PluginSecret,
  type PluginSmokeTest, type PluginSourceKind, type PluginUploadedIcon, type Visibility,
} from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, varchar, pgTable, text, timestamp, uuid, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';

// The JSON-column / enum types are plugin WIRE types owned by api-core
// (`types/plugin-wire.ts`) and re-exported here for existing importers.
export type {
  ImageSource, PluginContractValueType, PluginIcon, PluginLifecycle, PluginSecret, PluginSmokeTest, PluginUploadedIcon,
} from '@pipeline-builder/api-core';

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

  // Catalog metadata: detected from the package (spec, README,
  // the plugin's own Dockerfile OCI labels), then accepted or edited by the
  // user. `summary` is the card one-liner; `displayName` falls back to
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
  // Of the critical/high findings, those grype reports a fixed version for —
  // what the platform floor (PLUGIN_VULN_MAX_FINDINGS) gates on. NULL = unscanned.
  vulnCriticalFixable: integer('vuln_critical_fixable'),
  vulnHighFixable: integer('vuln_high_fixable'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }),
  // Set by the nightly rescan while this version's fixable criticals exceed the
  // floor (cleared when resolved): the counts and top findings at that rescan.
  scanFlaggedAt: timestamp('scan_flagged_at', { withTimezone: true }),
  scanFlag: jsonb('scan_flag').$type<PluginScanFlag>(),
  /**
   * The LAST rescan's findings for this version, written whether or not the
   * gating flag tripped.
   *
   * `scan_flag` is set only while fixable criticals exceed
   * PLUGIN_VULN_MAX_FINDINGS, so a version carrying only High findings stores
   * nothing — and the vulnerability report section, whose whole job is to show
   * Critical AND High exposure, had no source to read. This holds the counts and
   * the top findings for every in-use version, independent of the gate: what a
   * report shows and what a build refuses are different questions.
   */
  scanSummary: jsonb('scan_summary').$type<PluginScanSummary>(),
  runAsRoot: boolean('run_as_root'),

  // Version lifecycle. `breaking`: a publisher-marked major that `latest`
  // installs never cross without re-approval. `frozenAt`: set the moment a
  // publish request references this version — re-uploading it is then refused
  // (409). Yank / deprecation carry their reason alongside the timestamp.
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

  // Kept build context (nightly CVE remediation): the version's ZIP copied to
  // the plugin-sources bucket at store time (api-core `pluginSourceKey`), its
  // SHA-256 (checked before any rebuild; a mismatch fails closed), size, and
  // when it was kept. source_kind 'none' = no kept source (a prebuilt-image
  // upload, or a source lost after a restore): overlay-only remediation.
  sourceKey: text('source_key'),
  sourceSha256: varchar('source_sha256', { length: 64 }),
  sourceSizeBytes: bigint('source_size_bytes', { mode: 'number' }),
  sourceKind: varchar('source_kind', { length: 10 }).$type<PluginSourceKind>().default('none').notNull(),
  sourceKeptAt: timestamp('source_kept_at', { withTimezone: true }),
  // Set on every version a by-name delete (DELETE /plugins/by-name/:name)
  // soft-deleted; by-name restore and purge act on that batch only.
  deleteBatchId: uuid('delete_batch_id'),

  // Automatic tidying (api/plugin services/tidy/, docs/plugin-publishing.md
  // "Automatic tidying"). `lastUsedAt`: when POST /plugins/lookup (synth, the
  // pipeline save-time check) last resolved this version — written at most once
  // an hour per version. `tidyKeptAt`: the owner's Keep (or a restore) restarted
  // the clock. The version is stale `staleAfterDays` after the latest of
  // created / last used / kept. `tidyWarnedAt` + `tidyDeactivateAfter`: the
  // owner's digest listed it, and the date tidying deactivates it (never sooner
  // than 7 days after the warning). `tidyDeactivatedAt`: tidying set
  // `is_active = false` (an exact pin still resolves it, with a warning).
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  tidyKeptAt: timestamp('tidy_kept_at', { withTimezone: true }),
  tidyWarnedAt: timestamp('tidy_warned_at', { withTimezone: true }),
  tidyDeactivateAfter: timestamp('tidy_deactivate_after', { withTimezone: true }),
  tidyDeactivatedAt: timestamp('tidy_deactivated_at', { withTimezone: true }),
}, (table) => ({
  deleteBatchIdx: index('plugin_delete_batch_idx').on(table.orgId, table.deleteBatchId).where(sql`delete_batch_id IS NOT NULL`),
  // Partial index over just the tombstones — drives the retention purge sweep.
  purgeIdx: index('plugin_purge_idx').on(table.purgeAfter).where(sql`deleted_at IS NOT NULL`),
  // Mirrors the indexes postgres-init.sql creates, name for name (the SQL file is
  // what deploys; schema-reflection.test.ts keeps the two in lock-step).
  orgIdIdx: index('idx_plugins_org_id').on(table.orgId).where(sql`deleted_at IS NULL`),
  nameIdx: index('idx_plugins_name').on(table.name).where(sql`deleted_at IS NULL`),
  nameVersionIdx: index('idx_plugins_name_version').on(table.name, table.version).where(sql`deleted_at IS NULL`),
  visibilityIdx: index('idx_plugins_visibility').on(table.visibility).where(sql`deleted_at IS NULL`),
  isDefaultIdx: index('idx_plugins_is_default').on(table.name, table.isDefault).where(sql`is_default = true AND deleted_at IS NULL`),
  categoryIdx: index('idx_plugins_category').on(table.category),
  activeIdx: index('idx_plugins_is_active').on(table.isActive).where(sql`deleted_at IS NULL`),
  orgCreatedIdx: index('idx_plugins_org_created').on(table.orgId, sql`${table.createdAt} DESC`).where(sql`deleted_at IS NULL`),
  orgNameIdx: index('idx_plugins_org_name').on(table.orgId, table.name).where(sql`deleted_at IS NULL`),

  // Developer-portal catalog indexes: "my services" (owner) + lifecycle filter.
  ownerIdx: index('plugin_owner_idx').on(table.orgId, table.ownerId),
  lifecycleIdx: index('plugin_lifecycle_idx').on(table.orgId, table.lifecycle),

  // Composite index for filtered queries (orgId + visibility + isActive)
  orgVisibilityActiveIdx: index('plugin_org_visibility_active_idx').on(table.orgId, table.visibility, table.isActive),
  // Drives the "my private drafts" leg of the visibility predicate.
  createdByIdx: index('plugin_created_by_idx').on(table.orgId, table.createdBy),

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
  sourceKindCheck: check('plugin_source_kind_check', sql`${table.sourceKind} IN ('zip', 'none')`),
  sourceShaCheck: check('plugin_source_sha256_check', sql`${table.sourceSha256} IS NULL OR ${table.sourceSha256} ~ '^[0-9a-f]{64}$'`),
  // 'zip' carries key + checksum + size; 'none' carries none of them.
  sourceCoherenceCheck: check('plugin_source_coherence_check', sql`(${table.sourceKind} = 'zip' AND ${table.sourceKey} IS NOT NULL AND ${table.sourceSha256} IS NOT NULL AND ${table.sourceSizeBytes} IS NOT NULL) OR (${table.sourceKind} = 'none' AND ${table.sourceKey} IS NULL AND ${table.sourceSha256} IS NULL AND ${table.sourceSizeBytes} IS NULL)`),
}));

/**
 * What a kept setup image needs to become a version exactly as its build would
 * have made it: the plugin record the upload produced, the uploader and their
 * visibility-ladder authority, and the publish request the upload asked for.
 * Opaque to the database (the plugin service owns the shape).
 */
export type KeptSetupImageBuild = Record<string, unknown>;

/**
 * Gate-refused images from the SETUP catalog load, kept signed in the registry
 * for promotion instead of discarded (docs/plugin-publishing.md "Scan gates").
 * Written by the build worker for a system-org upload marked `setupLoad`;
 * promoted (re-gated, then saved through the build's own success path) or
 * discarded after `PLUGIN_KEPT_SETUP_IMAGE_TTL_DAYS`. System org only — listed
 * in the org cascade for its schema-reflection guard, but the cascade never
 * deletes the system org, so it never matches a row.
 *
 * @table plugin_kept_setup_images
 */
export const pluginKeptSetupImage = pgTable('plugin_kept_setup_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pluginName: varchar('plugin_name', { length: 255 }).notNull(),
  pluginVersion: varchar('plugin_version', { length: 50 }).notNull(),
  imageDigest: varchar('image_digest', { length: 71 }).notNull(),
  imageSource: varchar('image_source', { length: 10 }).$type<ImageSource>().notNull(),
  refusalCode: varchar('refusal_code', { length: 64 }).notNull(),
  refusalMessage: text('refusal_message').notNull(),
  refusalFindings: jsonb('refusal_findings').$type<unknown[]>().default([]).notNull(),
  build: jsonb('build').$type<KeptSetupImageBuild>().notNull(),
  keptBy: text('kept_by').notNull(),
  keptAt: timestamp('kept_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => ({
  identityIdx: uniqueIndex('plugin_kept_setup_image_identity_idx').on(table.orgId, table.pluginName, table.pluginVersion, table.imageDigest),
  expiresIdx: index('plugin_kept_setup_image_expires_idx').on(table.expiresAt),
  imageDigestCheck: check('plugin_kept_setup_image_digest_check', sql`${table.imageDigest} ~ '^sha256:[0-9a-f]{64}$'`),
  imageSourceCheck: check('plugin_kept_setup_image_source_check', sql`${table.imageSource} IN ('built', 'uploaded')`),
}));

/** An org's automatic tidying mode (`pluginRetention.autoTidy`). */
export type PluginAutoTidyMode = 'off' | 'notify' | 'on';

/**
 * An org's automatic plugin version tidying settings (`pluginRetention`; one
 * row per org, absent = defaults: notify, 90 days). `neverTidy` lists plugin
 * names tidying never touches; `lastDigestAt` is the org's last tidy digest
 * (at most one a week). Own-org RLS.
 *
 * @table plugin_retention_settings
 */
export const pluginRetentionSetting = pgTable('plugin_retention_settings', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  autoTidy: varchar('auto_tidy', { length: 10 }).$type<PluginAutoTidyMode>().default('notify').notNull(),
  staleAfterDays: integer('stale_after_days').default(90).notNull(),
  neverTidy: jsonb('never_tidy').$type<string[]>().default([]).notNull(),
  lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  autoTidyCheck: check('plugin_retention_settings_auto_tidy_check', sql`${table.autoTidy} IN ('off', 'notify', 'on')`),
  staleCheck: check('plugin_retention_settings_stale_check', sql`${table.staleAfterDays} >= 30`),
}));

export type PluginRetentionSetting = typeof pluginRetentionSetting.$inferSelect;

export type PluginKeptSetupImage = typeof pluginKeptSetupImage.$inferSelect;
export type PluginKeptSetupImageInsert = typeof pluginKeptSetupImage.$inferInsert;

/**
 * TypeScript types representing database rows
 */
export type Plugin = typeof plugin.$inferSelect;

/**
 * Compile-time pin: the drizzle row type and api-core's hand-written
 * {@link PluginRecord} wire type must be IDENTICAL (each assignable to the
 * other). Adding / retyping a column without updating `PluginRecord` fails
 * the build here.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const pluginRecordMatchesRow: Exactly<Plugin, PluginRecord> = true;
void pluginRecordMatchesRow;
export type PluginInsert = typeof plugin.$inferInsert;

/**
 * Helper types for working with partial updates
 */
export type PluginUpdate = Partial<Omit<PluginInsert, 'id' | 'createdAt' | 'createdBy'>>;
