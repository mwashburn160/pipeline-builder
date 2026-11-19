// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PLUGIN_NAME_PATTERN, PLUGIN_VERSION_PATTERN } from '@pipeline-builder/api-core';

/** Longest accepted plugin name (the CLI's `new-plugin` bound). */
const PLUGIN_NAME_MAX = 64;

/**
 * The name/version shape every plugin must have. Enforced server-side for
 * EVERY path that creates a version (tenant upload, anonymous submission, the
 * quarantine worker, the AI deploy): both flow into registry repository names
 * and tags, listing URLs and notification subjects, so a CR/LF or a path
 * separator in either is an injection, not a typo.
 *
 * Its own module (not plugin-spec.ts) so a route can apply it without pulling
 * in the zip parser and its build tooling. `label` names the source in the
 * message.
 */
export function pluginIdentityProblem(
  spec: { name?: unknown; version?: unknown },
  label = 'plugin-spec.yaml',
): string | null {
  if (typeof spec.name === 'string' && (spec.name.length > PLUGIN_NAME_MAX || !PLUGIN_NAME_PATTERN.test(spec.name))) {
    return `${label}: name must match ${PLUGIN_NAME_PATTERN} and be at most ${PLUGIN_NAME_MAX} characters`;
  }
  if (typeof spec.version === 'string' && (spec.version.length > 50 || !PLUGIN_VERSION_PATTERN.test(spec.version))) {
    return `${label}: version must be semver (${PLUGIN_VERSION_PATTERN})`;
  }
  return null;
}
