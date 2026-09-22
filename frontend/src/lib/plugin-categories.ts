// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin category vocabulary and its display maps.
 *
 * Deliberately NOT part of `@/lib/help`: importing the help barrel pulls every
 * generated help topic (hundreds of KB of source) into whatever bundle reads a
 * ten-element array, including the signed-out public directory.
 *
 * The IDs come from api-core (shared with `plugin-spec.yaml` and
 * `report-schema.json`); the display maps below are frontend-only.
 */

import { PLUGIN_CATEGORIES, type PluginCatalogCategory } from '@pipeline-builder/api-core/plugin-catalog';

/** Canonical lowercase category IDs (api-core's plugin-catalog vocabulary). */
export { PLUGIN_CATEGORIES, type PluginCatalogCategory };

/** Display labels for categories in the UI. */
export const CATEGORY_DISPLAY_NAMES: Record<PluginCatalogCategory, string> = {
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
export function isPluginCategory(value: unknown): value is PluginCatalogCategory {
  return typeof value === 'string' && (PLUGIN_CATEGORIES as readonly string[]).includes(value);
}

/**
 * One-line, plain-language description of each category — shown on the public
 * directory's category grid and landing pages and in the Plugins help topic.
 * Deliberately free of counts: those come live from the directory's facets.
 */
export const CATEGORY_DESCRIPTIONS: Record<PluginCatalogCategory, string> = {
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
export const CATEGORY_STAGES: Record<PluginCatalogCategory, string> = {
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
