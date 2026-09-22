// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin CATALOG metadata: the descriptive fields a plugin version shows in the
 * catalog, detected from the package and then accepted or edited by the user
 * (docs/plugin-publishing.md).
 *
 * ONE validator for both paths: a value detected from the package (spec,
 * README, the plugin's own Dockerfile labels) and a value typed into a form or
 * sent by the CLI pass the same rules. Shared from api-core so the plugin
 * service, the frontend and the CLI can't drift.
 *
 * Only DESCRIPTIVE fields live here. Execution-contract fields (commands, env,
 * secrets, compute type, …) are spec-only — changing one is a new version with a
 * new digest — and an edit payload naming one is refused
 * ({@link findContractKeys}).
 */

import { z } from 'zod';
import {
  PLUGIN_CATALOG_FIELDS,
  PLUGIN_CATEGORIES,
  PLUGIN_CHANGELOG_MAX_BYTES,
  PLUGIN_DESCRIPTION_MAX,
  PLUGIN_DISPLAY_NAME_MAX,
  PLUGIN_KEYWORD_MAX_LENGTH,
  PLUGIN_KEYWORDS_MAX,
  PLUGIN_README_MAX_BYTES,
  PLUGIN_SUMMARY_MAX,
  PLUGIN_URL_MAX,
  type PluginCatalogField,
} from '../types/plugin-catalog.js';

/**
 * Accepted SPDX license identifiers — a compact allowlist of the ids that
 * cover effectively every published plugin, rather than the full ~700-entry
 * SPDX list (an unfamiliar id is worth a human look). Case-sensitive, exactly
 * as SPDX spells them. `LicenseRef-Proprietary` is the SPDX-sanctioned
 * spelling for "not open source".
 */
export const SPDX_LICENSE_IDS: ReadonlySet<string> = new Set([
  'Apache-2.0', 'MIT', 'MIT-0', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0', 'Zlib', 'BSL-1.0',
  'BSD-2-Clause', 'BSD-3-Clause',
  'MPL-2.0', 'EPL-1.0', 'EPL-2.0',
  'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'CC-BY-4.0', 'CC-BY-SA-4.0', 'Python-2.0', 'PostgreSQL', 'Artistic-2.0',
  'BUSL-1.1', 'Elastic-2.0', 'SSPL-1.0',
  'LicenseRef-Proprietary',
]);

/** True when `id` is an accepted SPDX identifier. */
export function isAllowedSpdxId(id: string): boolean {
  return SPDX_LICENSE_IDS.has(id);
}

/**
 * URL shorteners refused in project links: a shortener hides the destination
 * from the reviewer and can be re-pointed after approval.
 */
export const URL_SHORTENER_HOSTS: ReadonlySet<string> = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at',
]);

/**
 * Why `raw` is not an acceptable project URL, or `null` when it is: must parse,
 * be `https:`, carry no userinfo, and not point at a known shortener (the host
 * or any parent domain of it).
 */
export function projectUrlProblem(raw: string): string | null {
  if (raw.length > PLUGIN_URL_MAX) return `must be at most ${PLUGIN_URL_MAX} characters`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username || url.password) return 'must not embed credentials';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (URL_SHORTENER_HOSTS.has(labels.slice(i).join('.'))) return `must not use a URL shortener (${host})`;
  }
  return null;
}

/** Curated icon / badge key: a file name under `deploy/plugins/_icons/`. */
export const ICON_KEY_PATTERN = /^[a-z0-9-]+$/;

// -----------------------------------------------------------------------------
// Field schemas
// -----------------------------------------------------------------------------

const utf8Bytes = (v: string): number => new TextEncoder().encode(v).length;

/** `https:` project URL, no shorteners, no credentials. */
export const ProjectUrlSchema = z.string().superRefine((v, ctx) => {
  const problem = projectUrlProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/** Curated icon / badge key. */
export const IconKeySchema = z.string().max(64).regex(ICON_KEY_PATTERN, 'must match ^[a-z0-9-]+$');

/**
 * Icon as stored: `{ key, badge? }`. A bare key string is accepted and
 * normalized first, so a bad key reports the key rule (not a bare union miss).
 */
export const PluginIconSchema = z.preprocess(
  (v) => (typeof v === 'string' ? { key: v } : v),
  z.object({ key: IconKeySchema, badge: IconKeySchema.optional() }).strict(),
);

/** A non-empty single-line-ish text field with a character cap. */
const text = (max: number) => z.string().trim().min(1, 'must not be empty').max(max, `must be at most ${max} characters`);

/**
 * Per-field validators for every DESCRIPTIVE field. A detected value
 * and a user-typed value both go through these.
 */
export const PLUGIN_CATALOG_FIELD_SCHEMAS = {
  summary: text(PLUGIN_SUMMARY_MAX),
  description: text(PLUGIN_DESCRIPTION_MAX),
  displayName: text(PLUGIN_DISPLAY_NAME_MAX),
  category: z.enum(PLUGIN_CATEGORIES, { message: `must be one of: ${PLUGIN_CATEGORIES.join(', ')}` }),
  keywords: z.array(
    z.string().trim().min(1, 'keywords must not be empty').max(PLUGIN_KEYWORD_MAX_LENGTH, `each keyword must be at most ${PLUGIN_KEYWORD_MAX_LENGTH} characters`),
  ).max(PLUGIN_KEYWORDS_MAX, `at most ${PLUGIN_KEYWORDS_MAX} keywords`),
  license: z.string().refine(isAllowedSpdxId, { message: 'must be a supported SPDX license identifier (e.g. Apache-2.0, MIT)' }),
  homepageUrl: ProjectUrlSchema,
  sourceUrl: ProjectUrlSchema,
  documentationUrl: ProjectUrlSchema,
  icon: PluginIconSchema,
  changelog: z.string().refine((v) => utf8Bytes(v) <= PLUGIN_CHANGELOG_MAX_BYTES, {
    message: `must be at most ${PLUGIN_CHANGELOG_MAX_BYTES} bytes`,
  }),
  readme: z.string().refine((v) => utf8Bytes(v) <= PLUGIN_README_MAX_BYTES, {
    message: `must be at most ${PLUGIN_README_MAX_BYTES} bytes`,
  }),
} as const satisfies Record<PluginCatalogField, z.ZodType>;

/**
 * Catalog EDITS (the upload's `metadata` part, a `PUT /plugins/:id` body's
 * descriptive keys, the CLI's `--metadata` file). `null` clears a field.
 * Strict: an unknown key is an error, never silently dropped.
 */
export const PluginCatalogEditsSchema = z.object(
  Object.fromEntries(PLUGIN_CATALOG_FIELDS.map((f) => [f, PLUGIN_CATALOG_FIELD_SCHEMAS[f].nullable().optional()])) as {
    [K in PluginCatalogField]: z.ZodOptional<z.ZodNullable<typeof PLUGIN_CATALOG_FIELD_SCHEMAS[K]>>;
  },
).strict();
export type PluginCatalogEdits = z.infer<typeof PluginCatalogEditsSchema>;

/**
 * Validate one field's value. Returns the normalized value (trimmed text, an
 * icon string as `{ key }`) or the reason it was refused — so a detected value
 * that fails is shown BLANK WITH THE REASON rather than silently dropped.
 */
export function validateCatalogField<F extends PluginCatalogField>(
  field: F,
  value: unknown,
): { ok: true; value: z.infer<typeof PLUGIN_CATALOG_FIELD_SCHEMAS[F]> } | { ok: false; error: string } {
  const result = (PLUGIN_CATALOG_FIELD_SCHEMAS[field] as z.ZodType).safeParse(value);
  if (result.success) return { ok: true, value: result.data as z.infer<typeof PLUGIN_CATALOG_FIELD_SCHEMAS[F]> };
  return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
}

// -----------------------------------------------------------------------------
// Execution contract (never editable)
// -----------------------------------------------------------------------------

/**
 * Keys that describe WHAT RUNS. They come only from the spec: changing one is a
 * new version, a new digest and a review diff. A metadata edit
 * naming any of them is refused with 400 — the refusal is the API's, not just
 * the UI's. `name`/`version` key the pushed image and are immutable too.
 */
export const PLUGIN_CONTRACT_FIELDS = [
  'name', 'version',
  'commands', 'installCommands', 'env', 'buildArgs', 'secrets',
  'metadata', 'requiredMetadata', 'requiredVars', 'metadataTypes', 'varsTypes',
  'network', 'networkEgress', 'computeType', 'pluginType', 'primaryOutputDirectory',
  'smokeTest', 'timeout', 'failureBehavior', 'dockerfile', 'buildType',
] as const;

/** The execution-contract keys present in `payload` (empty when none). */
export function findContractKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return PLUGIN_CONTRACT_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(payload, k));
}

/** The message a contract-key refusal carries. */
export function contractKeysMessage(keys: readonly string[]): string {
  return `These fields define what the plugin runs and can only change by uploading a new version: ${keys.join(', ')}`;
}
