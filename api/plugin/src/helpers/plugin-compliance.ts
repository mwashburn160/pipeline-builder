// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The attributes the plugin service sends to the compliance service
 * (W0.6), so the curated SOC2/PCI/CIS plugin rules evaluate REAL data:
 * `signed`, `scanned`, `vuln*`, `runAsRoot`, `packages` and `tags`.
 *
 * - At UPLOAD the image does not exist yet: for an image plugin the image
 *   facts are DEFERRED (rules reading them are skipped, never passed) and only
 *   `tags` is sent. A plugin that runs no image of its own is honestly
 *   unsigned/unscanned with no packages — nothing is deferred for it.
 * - After the BUILD the worker has pushed, signed and scanned the image and
 *   sends every fact, `packages` from the signed SBOM included
 *   ({@link postBuildComplianceAttributes}).
 * - On UPDATE the stored row's facts are sent; `packages` stays deferred (it
 *   was evaluated post-build and can't change without a rebuild).
 *
 * The derivation itself (`derivePluginImageCompliance`) is api-core's — the
 * compliance service's scans and entity events use the same one.
 */

import {
  PLUGIN_IMAGE_COMPLIANCE_FIELDS, derivePluginImageCompliance, pluginComplianceTags, pluginRunsOwnImage,
  type PluginComplianceAttributes, type PluginImageRow,
} from '@pipeline-builder/api-core';

export interface ComplianceImageFacts {
  attributes: PluginComplianceAttributes;
  deferredFields: string[];
}

/** Upload-time image facts: `tags`, with the image fields deferred for an image plugin. */
export function uploadComplianceImageFacts(row: { buildType: string; pluginType: string; keywords: string[]; labels?: unknown }): ComplianceImageFacts {
  if (!pluginRunsOwnImage(row)) {
    const derived = derivePluginImageCompliance(row, []);
    return { attributes: derived.attributes, deferredFields: derived.deferredFields };
  }
  return {
    attributes: { tags: pluginComplianceTags(row.keywords, row.labels) },
    deferredFields: [...PLUGIN_IMAGE_COMPLIANCE_FIELDS],
  };
}

/**
 * Post-build facts: the stored-row derivation over the freshly built image
 * (digest, scan, USER) plus the SBOM's package names (`null` when the SBOM
 * could not be read — the attribute is then omitted, not faked).
 */
export function postBuildComplianceAttributes(row: PluginImageRow, packages: string[] | null): ComplianceImageFacts {
  const derived = derivePluginImageCompliance(row, packages);
  return { attributes: derived.attributes, deferredFields: derived.deferredFields };
}

/** Update-time facts from the stored row (`packages` deferred). */
export function storedComplianceImageFacts(row: PluginImageRow): ComplianceImageFacts {
  const derived = derivePluginImageCompliance(row);
  return { attributes: derived.attributes, deferredFields: derived.deferredFields };
}
