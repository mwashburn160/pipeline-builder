// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from '@pipeline-builder/pipeline-data';
import { resolveSelfReferencing, resolveTemplates } from './index.js';

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
  'commands', // string[]
  'installCommands', // string[]
  'env', // Record<string, string>
  'buildArgs', // Record<string, string>
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

  // The `env` scope root IS the clone's env map, not the original: with
  // `plugin.env` — the UNRESOLVED values — `B: '{{ env.A }}'` would substitute
  // A's raw template text, baking the literal `{{ … }}` into the CodeBuild
  // environment and shell commands with no error. A cycle (A↔B) likewise.
  const env = (clone.env ?? {}) as Record<string, string>;
  const scope = {
    ...pipelineScope,
    plugin: { name: plugin.name, version: plugin.version },
    env,
  };

  // Pass 1 — `env` first, as a self-referencing document: topologically ordered
  // so each value resolves after the ones it reads, with cycles reported rather
  // than silently left as template text. Resolving writes back into `env`, which
  // is the scope root, so later references see resolved values.
  const envPass = resolveSelfReferencing(
    { env },
    scope,
    (field) => field === 'env' || field.startsWith('env.'),
    (field) => field,
  );

  // Pass 2 — everything else, against the now-resolved `env`. `env` itself is
  // excluded: its values are final, and one produced by an escape (`{{{{x}}` →
  // `{{x}}`) must not be tokenized a second time as if it were an expression.
  const rest = resolveTemplates(
    clone,
    scope,
    (field) => isPluginTemplatableField(field) && !(field === 'env' || field.startsWith('env.')),
  );

  const errors = [...envPass.errors, ...rest.errors];
  if (errors.length > 0) {
    // First error wins — resolver errors should never be batched at synth time
    // because a broken template is a programmer error, not a validation step.
    const e = errors[0]!;
    const msg = `Template resolution failed in plugin "${plugin.name}" at field '${e.field ?? e.path ?? 'env'}': ${e.message}`;
    throw new Error(msg);
  }
  return clone;
}
