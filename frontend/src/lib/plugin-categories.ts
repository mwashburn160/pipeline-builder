// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin category vocabulary.
 *
 * Lives here, NOT in `@/lib/help`, because it is needed by `usePlugins` — which
 * `useAuth` pulls into the provider tree on every route. Importing it from the
 * help barrel dragged all thirteen generated help topics (~588 KB of source,
 * `env-variables` and `deployment` alone over 2,000 lines each) into the shared
 * bundle, including the signed-out landing page, to read a ten-element array.
 *
 * The IDs are the canonical lowercase categories shared with `plugin-spec.yaml`
 * and `report-schema.json`.
 */

/** Canonical lowercase category IDs matching plugin-spec.yaml and report-schema.json. */
export const PLUGIN_CATEGORIES = [
  'language',
  'security',
  'quality',
  'monitoring',
  'artifact',
  'deploy',
  'infrastructure',
  'testing',
  'notification',
  'ai',
] as const;

export type PluginCategory = typeof PLUGIN_CATEGORIES[number];

/** Display labels for categories in the UI. */
export const CATEGORY_DISPLAY_NAMES: Record<PluginCategory, string> = {
  language: 'Language',
  security: 'Security',
  quality: 'Quality',
  monitoring: 'Monitoring',
  artifact: 'Artifact & Registry',
  deploy: 'Deploy',
  infrastructure: 'Infrastructure',
  testing: 'Testing',
  notification: 'Notification',
  ai: 'AI',
};
