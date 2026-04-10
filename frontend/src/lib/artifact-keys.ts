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
import type { FormBuilderState, FormStage } from '@/types/form-types';

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
 * Look up a plugin's `primaryOutputDirectory` by name from the plugin list.
 * Returns the default version (isDefault=true) first, otherwise the first match.
 */
function getOutputDir(plugins: Plugin[], pluginName: string): string | undefined {
  if (!pluginName) return undefined;
  const matches = plugins.filter((p) => p.name === pluginName);
  const defaultMatch = matches.find((p) => p.isDefault);
  const plugin = defaultMatch ?? matches[0];
  return plugin?.primaryOutputDirectory ?? undefined;
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
 * @param plugins - Loaded plugin list (with primaryOutputDirectory)
 * @param currentStageIndex - Index of the stage being edited
 * @param currentStepIndex - Index of the step being edited within the stage
 * @returns Flat list of artifact key options
 */
export function computeAvailableArtifacts(
  synth: FormBuilderState['synth'],
  stages: FormStage[],
  plugins: Plugin[],
  currentStageIndex: number,
  currentStepIndex: number,
): ArtifactKeyOption[] {
  const options: ArtifactKeyOption[] = [];

  // Synth step artifact
  const synthPluginName = synth.plugin.name;
  const synthOutputDir = getOutputDir(plugins, synthPluginName);
  if (synthPluginName && synthOutputDir) {
    const synthAlias = synth.plugin.alias || `${synthPluginName}-alias`;
    const key = buildKey('no-stage', 'no-stage-alias', synthPluginName, synthAlias, synthOutputDir);
    options.push({
      key,
      label: `${synthPluginName} → ${synthOutputDir}`,
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
      const outputDir = getOutputDir(plugins, pluginName);
      if (!pluginName || !outputDir) continue;

      const pluginAlias = step.plugin.alias || `${pluginName}-alias`;
      const key = buildKey(stageName, stageAlias, pluginName, pluginAlias, outputDir);
      options.push({
        key,
        label: `${pluginName} → ${outputDir}`,
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
