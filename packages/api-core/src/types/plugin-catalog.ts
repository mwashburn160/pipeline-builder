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

/**
 * The managed toolchain name a plugin REFERENCE resolves, or null: the
 * reference's `filter.name` wins over its `name` (as in pipeline-core's
 * `pluginLookupFilter`), so `{ name: 'BuildSynth', filter: { name: 'cdk-synth' } }`
 * is a managed `cdk-synth`.
 */
export function managedToolchainRefName(ref: { name?: unknown; filter?: unknown } | null | undefined): ManagedToolchainPlugin | null {
  if (!ref) return null;
  const filterName = ref.filter && typeof ref.filter === 'object' ? (ref.filter as { name?: unknown }).name : undefined;
  const name = typeof filterName === 'string' && filterName !== '' ? filterName : ref.name;
  return typeof name === 'string' && isManagedToolchainPlugin(name) ? name.trim().toLowerCase() as ManagedToolchainPlugin : null;
}

/**
 * Whether a managed reference's filter pins its own version (exact or range) or
 * row id. Refused: a managed half is pinned only as a whole release
 * (`toolchain.release`, TOOLCHAIN_PIN_VIA_RELEASE).
 */
export function managedRefPinsVersion(filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return false;
  const { version, id } = filter as { version?: unknown; id?: unknown };
  return (typeof version === 'string' && version.trim() !== '') || id !== undefined;
}

/** A pipeline's `toolchain.release` pin (its props), when it carries one. */
export function toolchainReleasePin(props: unknown): string | undefined {
  const toolchain = props && typeof props === 'object' ? (props as { toolchain?: unknown }).toolchain : undefined;
  const release = toolchain && typeof toolchain === 'object' ? (toolchain as { release?: unknown }).release : undefined;
  return typeof release === 'string' && release.trim() !== '' ? release.trim() : undefined;
}

/**
 * Where a pipeline's BUILD IMAGE (the toolchain release's `pipeline-bootstrap`
 * half) is recorded in its deployed step manifest (docs/plans/
 * bootstrap-image-versioning.md §4). The bootstrap is not a step, so its entry
 * is a non-step row: `step_key` is {@link BUILD_IMAGE_STEP_KEY} (the key its
 * lookup warnings are recorded under too) and its (stage, action) are these
 * sentinels. The stage name holds characters CodePipeline never allows in a
 * stage name, so event ingest's (pipeline, stage, action) join can never match
 * it to a real action.
 */
export const BUILD_IMAGE_STEP_KEY = 'build-image';
export const BUILD_IMAGE_MANIFEST_STAGE = '(toolchain)';
export const BUILD_IMAGE_MANIFEST_ACTION = 'build-image';
