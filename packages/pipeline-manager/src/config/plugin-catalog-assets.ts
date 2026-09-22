// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The curated icon keys `plugin new --icon` accepts (deploy/plugins/_icons,
 * plugin-ecosystem §6a.1). The CLI ships without the repo, so they are listed
 * here; a test fails when the list drifts from the tree. The base images live
 * in api-core (`PLUGIN_BASE_IMAGES`), shared with AI plugin generation.
 */

/**
 * Curated icon keys (`deploy/plugins/_icons/<key>.svg`). Reserved for Official
 * listings and Verified publishers who own the mark (§6a.1, G51): a Community
 * listing uses an uploaded raster icon or its monogram.
 */
export const CURATED_ICON_KEYS: readonly string[] = [
  'apachemaven', 'checkmarx', 'codacy', 'codecov', 'cplusplus', 'cypress', 'datadog', 'dependencycheck', 'docker',
  'dotnet', 'eslint', 'flyway', 'github', 'gnubash', 'go', 'googlecloud', 'helm', 'jest', 'jfrog', 'k6', 'kubernetes',
  'newrelic', 'nodejs', 'npm', 'nuget', 'openjdk', 'pagerduty', 'paloaltonetworks', 'php', 'postman', 'prettier',
  'pulumi', 'pypi', 'pytest', 'python', 'ruby', 'rubygems', 'rubyonrails', 'ruff', 'rust', 'sentry', 'serverless',
  'snyk', 'sonarcloud', 'terraform', 'trivy', 'typescript',
];
