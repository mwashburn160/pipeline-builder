// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The plugin catalog: a plugin and its versions, the descriptive fields an
 *  author edits, the dry-run inspect result and the build queue behind uploads. */

import type { Criticality, EntityLink, Lifecycle, OwnerType, Visibility } from '@pipeline-builder/api-core';
import type { MetadataSource, PluginCatalogField } from '@pipeline-builder/api-core/plugin-catalog';

/**
 * BullMQ build queue job counts (admin-only)
 */
export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface QueueStatus extends QueueCounts {
  dlq?: QueueCounts;
  /** Per-tier breakdown of waiting/active/etc. counts. Aggregate fields on
   *  the root object are the sum across all tier queues. */
  tiers?: Record<string, QueueCounts>;
}

/**
 * The descriptive (editable) catalog fields of a plugin version, in display
 * order, and where each value came from — api-core's plugin-catalog vocabulary.
 * Everything else on a plugin is its execution contract and changes only with a
 * new upload.
 */
export { PLUGIN_CATALOG_FIELDS } from '@pipeline-builder/api-core/plugin-catalog';
export type { MetadataSource, PluginCatalogField };

/** Curated icon / badge key, as stored. */
export interface PluginIcon { key: string; badge?: string }

/**
 * Catalog EDITS — the upload's `metadata` part and the descriptive keys of a
 * `PUT /plugins/:id` body. Only edited fields are present; `null` clears one.
 */
export interface PluginCatalogEdits {
  displayName?: string | null;
  summary?: string | null;
  description?: string | null;
  category?: string | null;
  keywords?: string[] | null;
  license?: string | null;
  homepageUrl?: string | null;
  sourceUrl?: string | null;
  documentationUrl?: string | null;
  icon?: string | PluginIcon | null;
  changelog?: string | null;
  readme?: string | null;
}

/** One field of a `POST /plugins/inspect` result. */
export interface PluginInspectField {
  field: PluginCatalogField;
  /** string | string[] (keywords) | {key, badge?} (icon) | null. */
  value: unknown;
  source: Exclude<MetadataSource, 'user'> | null;
  /** Why the detected value was refused (then `value` is null). */
  error: string | null;
}

/** `POST /plugins/inspect` payload: a dry-run parse of a plugin package. */
export interface PluginInspectResult {
  plugin: { name: string; version: string; pluginType: string; buildType: string };
  fields: PluginInspectField[];
}

/**
 * Plugin model
 */
export interface Plugin {
  // Primary key
  id: string;
  
  // Organization and access control
  orgId: string;
  
  // Audit fields
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  
  // Core plugin information
  name: string;
  description?: string;
  keywords: string[];
  category?: string;
  version: string;
  
  // Plugin configuration
  metadata: Record<string, string | number | boolean>;
  pluginType: string;
  computeType: string;
  timeout?: number;
  failureBehavior?: 'fail' | 'warn' | 'ignore';
  secrets?: Array<{ name: string; required: boolean; description?: string }>;

  // Build configuration
  env: Record<string, string>;
  /** Docker build args, templatable via `{{ pipeline.* }}` (e.g. `{{ pipeline.vars.* }}`). */
  buildArgs?: Record<string, string>;
  installCommands: string[];
  commands: string[];
  
  // Output configuration
  primaryOutputDirectory?: string;

  // Docker configuration
  /** Computed image URI: `<namespace>/<name>:<version>`. Server-side derived. */
  uri: string;
  dockerfile?: string;
  /** How the image is produced; `metadata_only` plugins have no image of their own. */
  buildType: 'build_image' | 'prebuilt' | 'metadata_only';

  // Supply chain — set once the image is pushed, cosign-signed and carries its
  // SBOM attestation (signing failure fails the build, so a digest ⇒ signed).
  // NULL for plugins that produce no image, and for an image-producing plugin
  // that predates signing (synth refuses those; see `pluginProducesImage`).
  /** `sha256:<64 hex>` of the pushed, signed image. */
  imageDigest: string | null;
  /** `built` = BuildKit on the platform (SLSA provenance); `uploaded` = a prebuilt image.tar (no provenance). */
  imageSource: 'built' | 'uploaded' | null;

  // Developer-portal catalog metadata (ownership / lifecycle / classification)
  ownerId?: string | null;
  ownerType?: OwnerType | null;
  /** Catalog lifecycle stage. `notNull` + DEFAULT 'production' in the schema and
   *  never projected away, so every row carries one. */
  lifecycle: Lifecycle;
  criticality?: Criticality | null;
  labels?: Record<string, string>;
  links?: EntityLink[];

  // Catalog metadata: detected from the package, then
  // accepted or edited. `metadataSources` records where each field came from.
  displayName?: string | null;
  summary?: string | null;
  license?: string | null;
  homepageUrl?: string | null;
  sourceUrl?: string | null;
  documentationUrl?: string | null;
  icon?: PluginIcon | null;
  changelog?: string | null;
  readmeMd?: string | null;
  readmeHtml?: string | null;
  metadataSources?: Partial<Record<PluginCatalogField, MetadataSource>>;
  deprecatedAt?: string | null;
  deprecationMessage?: string | null;
  yankedAt?: string | null;
  yankReason?: string | null;

  // Vulnerability scan (grype over the SBOM at build; nightly rescan). NULL
  // counts = never scanned. A finding is FIXABLE when a fixed version is known;
  // the build gates compare fixable Criticals only.
  vulnCritical?: number | null;
  vulnHigh?: number | null;
  vulnCriticalFixable?: number | null;
  vulnHighFixable?: number | null;
  scannedAt?: string | null;
  /** Set while a rescan finds fixable Criticals over the platform floor. */
  scanFlaggedAt?: string | null;
  /** The rescan's counts and top findings (see `normalizeScanFlag`). */
  scanFlag?: unknown;

  // Access and visibility
  visibility: Visibility;
  isDefault: boolean;
  isActive: boolean;

  // Deletion tracking (soft delete)
  deletedAt?: string;
  deletedBy?: string;
}


/**
 * An existing catalog plugin the AI plugin generator judged similar to the
 * prompt (`similarPlugins` on `POST /plugins/generate` and the stream's `done`
 * event). A hint to reuse it rather than generate a duplicate.
 */
export interface SimilarPlugin {
  id: string;
  name: string;
  version: string;
  category: string | null;
  /** Card one-liner, or a truncated description. */
  summary: string | null;
  keywords: string[];
}

/** The `done` payload of AI plugin generation. */
export interface PluginGenerationDone<TConfig> {
  config: TConfig;
  dockerfile: string;
  /** Closest existing catalog plugins; empty when none (or the lookup failed). */
  similarPlugins?: SimilarPlugin[];
  /** Catalog Dockerfile rules the generated Dockerfile breaks (non-root USER, fetch-verified downloads, …); empty when compliant. */
  dockerfileViolations?: string[];
}
