// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module lib/artifact-keys
 * @description Utility for computing available artifact key options from
 * the current pipeline form state.
 *
 * Artifact keys follow the format:
 * `stageName:stageAlias:pluginName:pluginAlias:outputDirectory`
 *
 * Only steps whose plugin has a `primaryOutputDirectory` produce artifacts.
 * The synth step always uses `no-stage:no-stage-alias` for its stage segments.
 */

import type { Plugin } from '@/types';
import type { FormBuilderState, FormPluginOptions, FormStage } from '@/types/form-types';
import type { CatalogEntry } from '@/types/plugin-installs';

/** A single artifact key option for the autocomplete dropdown. */
export interface ArtifactKeyOption {
  /** Full colon-delimited artifact key string. */
  key: string;
  /** Human-readable label (e.g., "cdk-synth → cdk.out"). */
  label: string;
  /** Category for grouping (e.g., "Synth" or the stage name). */
  category: string;
}

/** A group of artifact key options under a shared category header. */
export interface ArtifactKeyGroup {
  category: string;
  options: ArtifactKeyOption[];
}

/**
 * The plugin-alias segment of an artifact key and the pipeline's lookup key for
 * a plugin reference. Mirrors pipeline-core's `pluginArtifactAlias` exactly:
 * the explicit alias, else `<publisher>-<name>-alias` for a publisher-qualified
 * reference, else `<name>-alias`.
 */
export function pluginArtifactAlias(plugin: { alias?: string | null; publisher?: string | null; name: string }): string {
  if (plugin.alias) return plugin.alias;
  return plugin.publisher ? `${plugin.publisher}-${plugin.name}-alias` : `${plugin.name}-alias`;
}

/** Where a step's plugin can come from: the org's own plugins and the in-app catalog's listings. */
export interface PluginOutputSources {
  /** Own-org plugin rows (`GET /plugins`). */
  plugins: Plugin[];
  /** Catalog entries (`GET /plugins/catalog`) — listings resolve through installs. */
  catalog?: CatalogEntry[];
}

/**
 * Look up the `primaryOutputDirectory` a plugin reference resolves to.
 *
 * - `publisher` set: only that publisher's listing (through its install).
 * - unqualified: the org's own plugin of that name first (default version,
 *   else the first match), then a listing whose pipeline reference is the bare
 *   name (the implicit Official install).
 */
function getOutputDir(sources: PluginOutputSources, ref: Pick<FormPluginOptions, 'publisher' | 'name'>): string | undefined {
  const { name } = ref;
  if (!name) return undefined;
  const publisher = ref.publisher?.trim() ?? '';
  const catalog = sources.catalog ?? [];
  if (publisher) {
    const entry = catalog.find((e) => e.listing.publisherHandle === publisher && e.listing.name === name);
    return entry?.resolved?.primaryOutputDirectory ?? undefined;
  }
  const matches = sources.plugins.filter((p) => p.name === name);
  const own = matches.find((p) => p.isDefault) ?? matches[0];
  if (own) return own.primaryOutputDirectory ?? undefined;
  const entry = catalog.find((e) => !e.reference.publisher && e.reference.name === name);
  return entry?.resolved?.primaryOutputDirectory ?? undefined;
}

/** `publisher/name` for a qualified reference, else the bare name. */
function refLabel(ref: Pick<FormPluginOptions, 'publisher' | 'name'>): string {
  return ref.publisher ? `${ref.publisher}/${ref.name}` : ref.name;
}

/**
 * Build the colon-delimited artifact key string.
 */
function buildKey(
  stageName: string,
  stageAlias: string,
  pluginName: string,
  pluginAlias: string,
  outputDir: string,
): string {
  return `${stageName}:${stageAlias}:${pluginName}:${pluginAlias}:${outputDir}`;
}

/**
 * Compute available artifact keys from the current form state.
 *
 * Returns only artifacts from steps that execute **before** the step
 * at `(currentStageIndex, currentStepIndex)`, plus the synth step output.
 *
 * @param synth - Current synth configuration from form state
 * @param stages - All pipeline stages from form state
 * @param sources - Own plugins and catalog listings (with primaryOutputDirectory)
 * @param currentStageIndex - Index of the stage being edited
 * @param currentStepIndex - Index of the step being edited within the stage
 * @returns Flat list of artifact key options
 */
export function computeAvailableArtifacts(
  synth: FormBuilderState['synth'],
  stages: FormStage[],
  sources: PluginOutputSources,
  currentStageIndex: number,
  currentStepIndex: number,
): ArtifactKeyOption[] {
  const options: ArtifactKeyOption[] = [];

  // Synth step artifact
  const synthPluginName = synth.plugin.name;
  const synthOutputDir = getOutputDir(sources, synth.plugin);
  if (synthPluginName && synthOutputDir) {
    const synthAlias = pluginArtifactAlias(synth.plugin);
    const key = buildKey('no-stage', 'no-stage-alias', synthPluginName, synthAlias, synthOutputDir);
    options.push({
      key,
      label: `${refLabel(synth.plugin)} → ${synthOutputDir}`,
      category: 'Synth',
    });
  }

  // Stage step artifacts (only from preceding steps)
  for (let si = 0; si <= currentStageIndex && si < stages.length; si++) {
    const stage = stages[si];
    const stageName = stage.stageName || `stage-${si + 1}`;
    const stageAlias = stage.alias || `${stageName}-alias`;
    const maxStep = si < currentStageIndex ? stage.steps.length : currentStepIndex;

    for (let stepi = 0; stepi < maxStep; stepi++) {
      const step = stage.steps[stepi];
      if (!step) continue;
      const pluginName = step.plugin.name;
      const outputDir = getOutputDir(sources, step.plugin);
      if (!pluginName || !outputDir) continue;

      const pluginAlias = pluginArtifactAlias(step.plugin);
      const key = buildKey(stageName, stageAlias, pluginName, pluginAlias, outputDir);
      options.push({
        key,
        label: `${refLabel(step.plugin)} → ${outputDir}`,
        category: stageName,
      });
    }
  }

  return options;
}

/**
 * Group a flat list of artifact key options by category.
 *
 * @param options - Flat list of options
 * @param filter - Optional text filter to match against key or label
 * @returns Grouped and filtered options
 */
export function groupArtifactOptions(
  options: ArtifactKeyOption[],
  filter: string,
): ArtifactKeyGroup[] {
  const query = filter.toLowerCase();
  const filtered = query
    ? options.filter(
        (o) =>
          o.key.toLowerCase().includes(query) ||
          o.label.toLowerCase().includes(query) ||
          o.category.toLowerCase().includes(query),
      )
    : options;

  const groupMap = new Map<string, ArtifactKeyOption[]>();
  for (const opt of filtered) {
    const existing = groupMap.get(opt.category);
    if (existing) {
      existing.push(opt);
    } else {
      groupMap.set(opt.category, [opt]);
    }
  }

  return Array.from(groupMap.entries()).map(([category, opts]) => ({
    category,
    options: opts,
  }));
}
