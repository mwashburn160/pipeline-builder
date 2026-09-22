// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Image facts for a STORED plugin (scheduled scans, async entity events).
 *
 * The curated plugin rules read `signed`, `scanned`, `vuln*`, `runAsRoot`,
 * `tags` and `packages`. A stored row carries the columns those derive from
 * (`imageDigest`, `scannedAt`, `vuln*`, `runAsRoot`, `keywords`, `labels`) but
 * not the derived names, so without this a scan reported every image plugin as
 * unsigned and unscanned. `derivePluginImageCompliance` is the same derivation
 * the plugin service sends on its live checks. `packages` is not a column: it
 * comes back deferred (it was evaluated by the build worker's post-build check
 * and cannot change without a rebuild).
 */

import { derivePluginImageCompliance } from '@pipeline-builder/api-core';

export function withPluginImageFacts(attributes: Record<string, unknown>): {
  attributes: Record<string, unknown>;
  deferredFields: string[];
} {
  const derived = derivePluginImageCompliance(attributes);
  return { attributes: { ...attributes, ...derived.attributes }, deferredFields: derived.deferredFields };
}
