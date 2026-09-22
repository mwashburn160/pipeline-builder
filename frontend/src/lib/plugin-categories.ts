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

/** Narrow an untrusted string (a URL segment, an API field) to a category id. */
export function isPluginCategory(value: unknown): value is PluginCategory {
  return typeof value === 'string' && (PLUGIN_CATEGORIES as readonly string[]).includes(value);
}

/**
 * One-line, plain-language description of each category — shown on the public
 * directory's category grid and landing pages and in the Plugins help topic.
 * Deliberately free of counts: those come live from the directory's facets.
 */
export const CATEGORY_DESCRIPTIONS: Record<PluginCategory, string> = {
  language: 'Build and test toolchains for Node, Python, Java, Go, Rust, .NET, Ruby, PHP and C/C++, pinned on shared base images.',
  security: 'Find problems before they ship: SAST, dependency (SCA) and secret scanning, container and IaC checks.',
  quality: 'Linters, formatters, type checks and coverage gates that keep a codebase consistent.',
  testing: 'Unit, integration, end-to-end, load and contract testing runners.',
  artifact: 'Package and publish what you build: container images, npm/PyPI/Maven packages, S3 artifacts.',
  deploy: 'Ship to AWS and beyond: CloudFormation/CDK, ECS, Lambda, Kubernetes, and cross-cloud deploys.',
  infrastructure: 'Synthesize and validate infrastructure as code, plus approval gates between stages.',
  monitoring: 'Post-deploy checks, observability hooks and release markers.',
  notification: 'Tell people what happened: Slack, Teams, email and webhook notifications.',
  ai: 'AI-assisted steps, e.g. generating Dockerfiles or reviewing changes.',
};

/** Where a category's plugins fit in a pipeline ("where it fits" on category pages). */
export const CATEGORY_STAGES: Record<PluginCategory, string> = {
  language: 'Build',
  security: 'Build · Test',
  quality: 'Build · Test',
  testing: 'Test',
  artifact: 'Publish',
  deploy: 'Deploy',
  infrastructure: 'Synth · Gate',
  monitoring: 'Post-deploy',
  notification: 'Any stage',
  ai: 'Any stage',
};
