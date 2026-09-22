// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin compliance attributes: what the plugin service tells compliance about
 * an uploaded plugin and its pushed image, derived from the stored plugin row.
 */

/**
 * The attributes the plugin service sends to `/compliance/validate/plugin`.
 *
 * The spec/config fields describe the plugin as uploaded. The image fields
 * describe what the platform itself established about the pushed image — the
 * facts the curated SOC2/PCI/CIS plugin rules evaluate:
 *
 * - `signed`: the image digest carries the platform's cosign signature.
 * - `scanned`: a vulnerability scan completed (`scannedAt` is set); the
 *   `vuln*` counts are present only then — an unscanned image sends no counts,
 *   so a numeric rule like `vulnCritical lt 1` cannot pass on a missing value.
 *   `vulnCriticalFixable` / `vulnHighFixable` count only the findings grype
 *   reports a fixed version for (what the platform floor gates on).
 * - `runAsRoot`: the image config's effective USER is root (empty, `0`, `root`).
 * - `packages`: package names from the signed SBOM.
 * - `tags`: the plugin's keywords plus `key=value` labels (CIS 2.1 inventory).
 *
 * Image fields are unknown until the build worker has pushed, signed and
 * scanned the image; the upload-time check lists them in `deferredFields`
 * and the worker re-validates once they are real.
 */
export interface PluginComplianceAttributes {
  name?: string;
  version?: string;
  pluginType?: string;
  computeType?: string;
  timeout?: number | null;
  failureBehavior?: string;
  env?: Record<string, string>;
  buildArgs?: Record<string, string>;
  installCommands?: string[];
  commands?: string[];
  visibility?: string;
  secrets?: unknown[];
  metadata?: Record<string, unknown>;
  keywords?: string[];
  buildType?: string;
  tags?: string[];
  signed?: boolean;
  scanned?: boolean;
  vulnCritical?: number;
  vulnHigh?: number;
  vulnMedium?: number;
  vulnLow?: number;
  vulnCriticalFixable?: number;
  vulnHighFixable?: number;
  runAsRoot?: boolean;
  packages?: string[];
  [key: string]: unknown;
}

/** Plugin attributes only the build worker can establish (see {@link PluginComplianceAttributes}). */
export const PLUGIN_IMAGE_COMPLIANCE_FIELDS = [
  'signed', 'scanned', 'vulnCritical', 'vulnHigh', 'vulnMedium', 'vulnLow',
  'vulnCriticalFixable', 'vulnHighFixable', 'runAsRoot', 'packages',
] as const;
export type PluginImageComplianceField = typeof PLUGIN_IMAGE_COMPLIANCE_FIELDS[number];

/** The stored plugin-row columns the image facts derive from (any subset). */
export interface PluginImageRow {
  buildType?: unknown;
  pluginType?: unknown;
  imageDigest?: unknown;
  scannedAt?: unknown;
  vulnCritical?: unknown;
  vulnHigh?: unknown;
  vulnMedium?: unknown;
  vulnLow?: unknown;
  vulnCriticalFixable?: unknown;
  vulnHighFixable?: unknown;
  runAsRoot?: unknown;
  keywords?: unknown;
  labels?: unknown;
}

const SIGNED_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Whether a plugin runs on its own image: `metadata_only` builds none and a
 * `ManualApprovalStep` never runs one. Same rule as the plugin worker's skip.
 */
export function pluginRunsOwnImage(row: Pick<PluginImageRow, 'buildType' | 'pluginType'>): boolean {
  return row.buildType !== 'metadata_only' && row.pluginType !== 'ManualApprovalStep';
}

/** CIS 2.1 inventory tags: the plugin's keywords plus its labels as `key=value`. */
export function pluginComplianceTags(keywords: unknown, labels?: unknown): string[] {
  const tags = new Set<string>();
  if (Array.isArray(keywords)) {
    for (const k of keywords) if (typeof k === 'string' && k.trim()) tags.add(k.trim());
  }
  if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
    for (const [k, v] of Object.entries(labels as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') tags.add(`${k}=${String(v)}`);
    }
  }
  return [...tags];
}

const finiteCount = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * The image-derived compliance attributes of a STORED plugin row (the plugin
 * service's update re-check, the build worker's post-build check, and the
 * compliance service's scans and entity events all derive them here, so the
 * rules see one definition of `signed`/`scanned`).
 *
 * - `signed`: the row carries a well-formed digest. The worker stores a digest
 *   only after image-registry signed it (a signing failure fails the build), so
 *   a digest on the row IS a platform signature.
 * - `scanned` + `vuln*`: counts only when `scannedAt` is set.
 * - `runAsRoot`: only when known.
 * - `packages`: not a row column. Pass the SBOM's names when you have them,
 *   `null` when the SBOM could not be read (attribute omitted, so a
 *   `$count(packages)` rule sees 0), or leave it `undefined` on a path that
 *   never reads SBOMs — it is then returned in `deferredFields` (it was
 *   evaluated by the post-build check and cannot change without a rebuild).
 *
 * A plugin that runs no image of its own is honestly unsigned and unscanned
 * with no packages; nothing is deferred for it.
 */
export function derivePluginImageCompliance(
  row: PluginImageRow,
  packages?: string[] | null,
): { attributes: PluginComplianceAttributes; deferredFields: PluginImageComplianceField[] } {
  const tags = pluginComplianceTags(row.keywords, row.labels);
  if (!pluginRunsOwnImage(row)) {
    return { attributes: { tags, signed: false, scanned: false, packages: [] }, deferredFields: [] };
  }
  const scanned = row.scannedAt !== null && row.scannedAt !== undefined;
  const attributes: PluginComplianceAttributes = {
    tags,
    signed: typeof row.imageDigest === 'string' && SIGNED_DIGEST_RE.test(row.imageDigest),
    scanned,
  };
  if (scanned) {
    attributes.vulnCritical = finiteCount(row.vulnCritical);
    attributes.vulnHigh = finiteCount(row.vulnHigh);
    attributes.vulnMedium = finiteCount(row.vulnMedium);
    attributes.vulnLow = finiteCount(row.vulnLow);
    attributes.vulnCriticalFixable = finiteCount(row.vulnCriticalFixable);
    attributes.vulnHighFixable = finiteCount(row.vulnHighFixable);
  }
  if (typeof row.runAsRoot === 'boolean') attributes.runAsRoot = row.runAsRoot;
  if (Array.isArray(packages)) attributes.packages = packages;
  for (const k of Object.keys(attributes)) if (attributes[k] === undefined) delete attributes[k];
  return { attributes, deferredFields: packages === undefined ? ['packages'] : [] };
}
