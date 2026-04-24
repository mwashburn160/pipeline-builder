// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from '@pipeline-builder/pipeline-data';
import { resolveTemplates } from './index';

/**
 * Fields inside a Plugin record that accept `{{ ... }}` templates.
 *
 * Pure-string leaves only. `name`, `version`, `pluginType`, `computeType`,
 * `timeout`, `secrets`, `failureBehavior`, `requiredMetadata`, `requiredVars`
 * stay literal. `metadata.*` is excluded because CDK-metadata values are
 * structural, not user-interpolated.
 */
const TEMPLATABLE_FIELDS = [
  'description',
  'commands',        // string[]
  'installCommands', // string[]
  'env',             // Record<string, string>
  'buildArgs',       // Record<string, string>
] as const;

export function isPluginTemplatableField(field: string): boolean {
  // `commands` / `installCommands` are arrays of strings → entries like 'commands[0]'
  // `env` / `buildArgs` are objects → entries like 'env.STAGE'
  return TEMPLATABLE_FIELDS.some(f => field === f || field.startsWith(`${f}[`) || field.startsWith(`${f}.`));
}

/**
 * Return a shallow clone of `plugin` with all `{{ ... }}` templates
 * resolved against the given pipeline scope. Caller must pre-populate
 * `pipelineScope` with `{ pipeline, plugin, env }` keys.
 */
export function resolvePluginTemplates(
  plugin: Plugin,
  pipelineScope: Record<string, unknown>,
): Plugin {
  // Deep clone so mutations don't leak back to the caller's Plugin.
  // Structural fields we care about are plain JSON; structuredClone is safe.
  const clone = structuredClone(plugin) as Plugin & Record<string, unknown>;

  const scope = {
    ...pipelineScope,
    plugin: { name: plugin.name, version: plugin.version, imageTag: plugin.imageTag },
    env: plugin.env ?? {},
  };

  const { errors } = resolveTemplates(clone, scope, isPluginTemplatableField, 'plugin');
  if (errors.length > 0) {
    // First error wins — resolver errors should never be batched at synth time
    // because a broken template is a programmer error, not a validation step.
    const e = errors[0]!;
    const msg = `Template resolution failed in plugin "${plugin.name}" at field '${e.field}': ${e.message}`;
    throw new Error(msg);
  }
  return clone;
}
