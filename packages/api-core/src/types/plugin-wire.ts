// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin WIRE types: the shape of a stored plugin row and of a plugin query
 * filter, as plain TypeScript with no drizzle dependency. They live here (not
 * in pipeline-data, which owns the table) so a package that only needs the
 * shape — pipeline-core's synth-time plugin lookup — does not take a runtime
 * dependency on the data layer. pipeline-data re-exports them and pins
 * {@link PluginRecord} to its drizzle row type with a compile-time equality
 * check, so the two cannot drift.
 */

import type { Criticality, EntityLabels, EntityLink, Lifecycle, OwnerType } from './catalog-metadata.js';
import type { ComputeType, PluginType } from './pipeline.js';
import type { MetadataSources } from './plugin-catalog.js';
import type { PluginScanFlag, PluginScanSummary } from './plugin-scan.js';
import type { Visibility } from './visibility.js';

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

/** A curated icon: a key into the curated set, plus an optional badge. */
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
 * A stored plugin row (`plugins` table) — pipeline-data's `Plugin` is this type.
 */
export interface PluginRecord {
  id: string;
  name: string;
  orgId: string;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
  description: string | null;
  keywords: string[];
  version: string;
  category: string;
  metadata: Record<string, string | number | boolean>;
  pluginType: PluginType;
  computeType: ComputeType;
  timeout: number | null;
  failureBehavior: 'fail' | 'warn' | 'ignore';
  secrets: PluginSecret[];
  primaryOutputDirectory: string | null;
  env: Record<string, string>;
  buildArgs: Record<string, string>;
  installCommands: string[];
  commands: string[];
  requiredMetadata: string[];
  requiredVars: string[];
  metadataTypes: Record<string, PluginContractValueType>;
  varsTypes: Record<string, PluginContractValueType>;
  smokeTest: PluginSmokeTest | null;
  networkEgress: string[];
  readmeMd: string | null;
  readmeHtml: string | null;
  license: string | null;
  changelog: string | null;
  homepageUrl: string | null;
  sourceUrl: string | null;
  icon: PluginIcon | null;
  uploadedIcon: PluginUploadedIcon | null;
  summary: string | null;
  displayName: string | null;
  documentationUrl: string | null;
  dockerfile: string | null;
  metadataSources: MetadataSources;
  buildType: string;
  imageDigest: string | null;
  imageSource: ImageSource | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
  vulnMedium: number | null;
  vulnLow: number | null;
  vulnCriticalFixable: number | null;
  vulnHighFixable: number | null;
  scannedAt: Date | null;
  scanFlaggedAt: Date | null;
  scanFlag: PluginScanFlag | null;
  scanSummary: PluginScanSummary | null;
  runAsRoot: boolean | null;
  breaking: boolean;
  frozenAt: Date | null;
  yankedAt: Date | null;
  yankReason: string | null;
  deprecatedAt: Date | null;
  deprecationMessage: string | null;
  ownerId: string | null;
  ownerType: OwnerType | null;
  lifecycle: PluginLifecycle;
  criticality: Criticality | null;
  labels: EntityLabels;
  links: EntityLink[];
  visibility: Visibility;
  isDefault: boolean;
  isActive: boolean;
  deletedAt: Date | null;
  deletedBy: string | null;
  purgeAfter: Date | null;
  quotaResetAt: Date | null;
}

/**
 * Base filter interface containing common filter properties shared across all entity types.
 *
 * @example
 * ```typescript
 * const filter: CommonFilter = {
 *   id: '123',
 *   orgId: 'my-org',
 *   visibility: 'public',
 *   isDefault: true,
 *   isActive: true
 * };
 * ```
 */
export interface CommonFilter {
  /**
   * Unique identifier for the entity
   * Can be a single ID or array of IDs for batch filtering
   */
  readonly id?: string | string[];

  // --- Viewer context (server-set, NEVER client-supplied) ---------------------
  // Only entities whose visibility predicate has a PER-USER rung read these —
  // pipeline templates (`private` is author-only) and messages (a per-user
  // targeted row is visible only to its target). Their services stamp them from
  // the request's `TenantContext` via `withViewerContext`, so no route or query
  // string can inject them. Everything else ignores them.
  //
  // Both fail CLOSED when absent: no viewer means the per-user rung matches
  // NOTHING, never everything.

  /** Caller's user id, matched against the entity's per-user column. */
  readonly viewerUserId?: string;
  /** Whether the caller is a platform super-admin (sees every rung). */
  readonly viewerIsSuperAdmin?: boolean;

  /**
   * Organization identifier to filter entities by organization
   * Can be a single org ID or array for multi-org filtering
   */
  readonly orgId?: string | string[];

  /**
   * Narrow to one rung of the shared three-rung sharing ladder. Applied WITHIN
   * what the caller can already see — never widens it.
   * @see Visibility
   */
  readonly visibility?: Visibility | string;

  /**
   * Filter by default status
   * - true: Only default entities
   * - false: Only non-default entities
   * - undefined: All entities
   */
  readonly isDefault?: boolean;

  /**
   * Filter by active/inactive status
   * - true: Only active entities
   * - false: Only inactive entities
   * - undefined: All entities
   */
  readonly isActive?: boolean;

  /**
   * Number of results to return
   * @minimum 1
   * @maximum 1000
   */
  readonly limit?: number;

  /**
   * Number of results to skip (for pagination)
   * @minimum 0
   */
  readonly offset?: number;

  /**
   * Sort field and direction
   * @example "name:asc", "createdAt:desc"
   */
  readonly sort?: string;

  /**
   * Filter by catalog owner (developer-portal "my services" view).
   * Matches the entity's `ownerId` exactly (a user id or team id).
   * Only applied by builders for entities that carry an owner column
   * (pipelines, plugins); ignored elsewhere.
   */
  readonly ownerId?: string;

  /**
   * Filter by lifecycle stage (experimental | production | deprecated).
   * Only applied by builders for entities that carry a lifecycle column.
   */
  readonly lifecycle?: string;
}

/**
 * Filter interface for plugin-specific properties.
 * Extends CommonFilter to include plugin-related filter options.
 *
 * @example
 * ```typescript
 * const filter: PluginFilter = {
 *   name: 'nodejs-build',
 *   version: '1.0.0',
 *   isActive: true
 * };
 * ```
 */
export interface PluginFilter extends CommonFilter {
  /**
   * Plugin name to filter by
   */
  readonly name?: string;

  /**
   * How `name` matches: `contains` (default — case-insensitive substring, for
   * list/search) or `exact` (resolution — the lookup path). Internal: not in
   * the public filter schema.
   */
  readonly nameMatch?: 'exact' | 'contains';

  /**
   * Publisher handle of an installed listing to resolve through.
   * Lookup only: a `plugins` row query ignores it (the resolver routes a
   * qualified reference to the listing, never to an org's own rows).
   */
  readonly publisher?: string;

  /**
   * Plugin version spec: exact (`1.2.3`), caret (`^1.2.3`), tilde (`~1.2.3`),
   * partial (`1`, `1.2`, `1.x`) or `latest` — see the plugin version-spec grammar in utils/semver.ts. A range never
   * matches a yanked version.
   * @example "1.0.0", "^2.0.0", "~1.2.3", "latest"
   */
  readonly version?: string;

  /** Exclude yanked versions (resolution without a version spec). Internal. */
  readonly excludeYanked?: boolean;

  /**
   * Exclude versions the nightly rescan flagged (`scan_flagged_at` set) — the
   * lookup's "newest unflagged version to move to" suggestion. Never applied to
   * what a reference RESOLVES to: vulnerability state does not skip versions. Internal.
   */
  readonly excludeScanFlagged?: boolean;

  /**
   * Keyword to search within the keywords JSONB array (case-insensitive contains)
   */
  readonly keyword?: string;

  /**
   * Plugin category to filter by
   * @example "language", "security", "testing"
   */
  readonly category?: string;
}
