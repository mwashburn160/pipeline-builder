// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin catalog vocabulary: the descriptive (editable) fields of a plugin
 * version, the category ids, the per-field provenance values and the size
 * limits. Dependency-free so the browser imports it through the
 * `@pipeline-builder/api-core/plugin-catalog` subpath; the Zod validators built
 * on it live in `validation/plugin-catalog-metadata.ts`.
 */

/** Card one-liner cap. */
export const PLUGIN_SUMMARY_MAX = 160;
/** `description` cap, characters. */
export const PLUGIN_DESCRIPTION_MAX = 2000;
/** `displayName` cap, characters. */
export const PLUGIN_DISPLAY_NAME_MAX = 100;
/** Max keywords, and max characters per keyword. */
export const PLUGIN_KEYWORDS_MAX = 10;
export const PLUGIN_KEYWORD_MAX_LENGTH = 32;
/** README.md cap, bytes (UTF-8). */
export const PLUGIN_README_MAX_BYTES = 64 * 1024;
/** `changelog` cap, bytes (UTF-8). */
export const PLUGIN_CHANGELOG_MAX_BYTES = 32 * 1024;
/** Project URL cap, characters. */
export const PLUGIN_URL_MAX = 2048;

/** Canonical plugin categories (the directory's category grid, `plugin-spec.yaml`, `report-schema.json`). */
export const PLUGIN_CATEGORIES = [
  'language', 'security', 'quality', 'monitoring', 'artifact',
  'deploy', 'infrastructure', 'testing', 'notification', 'ai',
] as const;
export type PluginCatalogCategory = typeof PLUGIN_CATEGORIES[number];

/** Every descriptive (editable) catalog field, in display order. */
export const PLUGIN_CATALOG_FIELDS = [
  'displayName', 'summary', 'description', 'category', 'keywords', 'license',
  'homepageUrl', 'sourceUrl', 'documentationUrl', 'icon', 'changelog', 'readme',
] as const;
export type PluginCatalogField = typeof PLUGIN_CATALOG_FIELDS[number];

/** The link fields — a user-edited link is highlighted in review. */
export const PLUGIN_CATALOG_LINK_FIELDS: ReadonlyArray<PluginCatalogField> = ['homepageUrl', 'sourceUrl', 'documentationUrl'];

/** Where a catalog field's value came from (stored per version in `metadata_sources`; `user` = edited by a person). */
export const METADATA_SOURCES = ['spec', 'readme', 'dockerfile', 'derived', 'user'] as const;
export type MetadataSource = typeof METADATA_SOURCES[number];
/** Per-field provenance of a version's catalog metadata. */
export type MetadataSources = Partial<Record<PluginCatalogField, MetadataSource>>;

// -----------------------------------------------------------------------------
// Managed toolchain names (docs/plans/bootstrap-image-versioning.md §1, D5)
// -----------------------------------------------------------------------------

/**
 * The managed toolchain plugins. `pipeline-bootstrap` (the CodeBuild image the
 * synth and self-mutation run on) and `cdk-synth` (the synth step) are ONE
 * release, published by the system org. Their names are reserved: only the
 * system org creates rows with them, they are never listed in the ecosystem,
 * an upload never promotes or overwrites them, and their lifecycle (default,
 * deprecate, yank, delete) is driven only by the Toolchain console, never the
 * generic plugin routes. Here (dependency-free) so the browser shares the list.
 */
export const MANAGED_TOOLCHAIN_PLUGINS = ['pipeline-bootstrap', 'cdk-synth'] as const;
export type ManagedToolchainPlugin = typeof MANAGED_TOOLCHAIN_PLUGINS[number];

/** Whether `name` is one of the reserved {@link MANAGED_TOOLCHAIN_PLUGINS} (exact, case-insensitive). */
export function isManagedToolchainPlugin(name: string | null | undefined): name is ManagedToolchainPlugin {
  if (typeof name !== 'string') return false;
  return (MANAGED_TOOLCHAIN_PLUGINS as readonly string[]).includes(name.trim().toLowerCase());
}
