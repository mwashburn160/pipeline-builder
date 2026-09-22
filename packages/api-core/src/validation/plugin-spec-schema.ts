// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin PACKAGE schemas: `plugin-spec.yaml` and `config.yaml`, exactly as
 * the plugin service validates an upload. Shared from api-core so the upload
 * path (api/plugin) and the CLI (`pipeline-manager plugin validate` /
 * `plugin publish`) apply ONE schema and can't drift (plugin-ecosystem W6).
 *
 * Pure: no YAML parsing, no filesystem. Callers parse (with their own size and
 * alias bounds) and hand the resulting object to {@link checkPluginSpec} /
 * {@link checkPluginConfig}.
 */

import { z } from 'zod';

import {
  IconKeySchema, PLUGIN_CATALOG_FIELD_SCHEMAS, PLUGIN_CHANGELOG_MAX_BYTES, ProjectUrlSchema, isAllowedSpdxId,
} from './plugin-catalog-metadata.js';

// -----------------------------------------------------------------------------
// Vocabularies
// -----------------------------------------------------------------------------

export const PLUGIN_TYPES = ['CodeBuildStep', 'ShellStep', 'ManualApprovalStep'] as const;
export const PLUGIN_COMPUTE_TYPES = ['SMALL', 'MEDIUM', 'LARGE', 'X2_LARGE'] as const;
export const PLUGIN_FAILURE_BEHAVIORS = ['fail', 'warn', 'ignore'] as const;
export const PLUGIN_BUILD_TYPES = ['build_image', 'prebuilt', 'metadata_only'] as const;
export type PluginBuildType = typeof PLUGIN_BUILD_TYPES[number];

/** Plugin name: lowercase letters, digits and hyphens. */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9-]+$/;
/** Plugin version: semver, with optional `-prerelease` and `+build` metadata. */
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;

// -----------------------------------------------------------------------------
// network.egress (spec-only trust metadata, W0.2)
// -----------------------------------------------------------------------------

/** Max declared `network.egress` hostnames. */
export const EGRESS_MAX_HOSTS = 50;

/**
 * A bare DNS hostname, optionally with ONE leading `*.` wildcard label. No
 * scheme, port, path, userinfo or IP literal — a declared egress target is a
 * name the reviewer can read.
 */
const EGRESS_HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** True when `host` is an acceptable `network.egress` entry. */
export function isValidEgressHost(host: string): boolean {
  return host.length <= 253 && EGRESS_HOST_PATTERN.test(host);
}

// -----------------------------------------------------------------------------
// config.yaml
// -----------------------------------------------------------------------------

export const PluginConfigSchema = z.object({
  pluginSpec: z.string().optional(),
  dockerfile: z.string().optional(),
  buildType: z.enum(PLUGIN_BUILD_TYPES).optional(),
  // Deterministic build tag written by build-plugin-images.sh
  // (`p-<name>-<sha256:12>`). Informational only on the upload path —
  // the platform doesn't act on it, but it lives in the same config
  // file as the rest of the build metadata so re-runs can short-circuit
  // unchanged plugins without needing a separate .image-hash sidecar.
  imageTag: z.string().optional(),
}).strict()
  .refine(d => !(d.buildType === 'prebuilt' && d.dockerfile), {
    message: 'dockerfile is not allowed when buildType is prebuilt',
  })
  .refine(d => !(d.buildType === 'metadata_only' && d.dockerfile), {
    message: 'dockerfile is not allowed when buildType is metadata_only',
  });
export type PluginConfigInput = z.infer<typeof PluginConfigSchema>;

// -----------------------------------------------------------------------------
// plugin-spec.yaml
// -----------------------------------------------------------------------------

// name/version/commands are the required-field contract, but they're checked by
// {@link pluginSpecRequiredFieldsProblem} (the stable "name, version, and
// commands are required" message and the ManualApprovalStep carve-out). Here
// they're optional strings; the schema's job is to reject malformed *types* on
// the fields that flow downstream unchecked.
export const PluginSpecSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  category: z.string().optional(),
  version: z.string().optional(),
  pluginType: z.enum(PLUGIN_TYPES).optional(),
  computeType: z.enum(PLUGIN_COMPUTE_TYPES).optional(),
  // >= 0 minutes: ManualApprovalStep specs legitimately declare `timeout: 0`.
  timeout: z.number().int().nonnegative().optional(),
  failureBehavior: z.enum(PLUGIN_FAILURE_BEHAVIORS).optional(),
  secrets: z.array(z.object({
    name: z.string().min(1),
    required: z.boolean(),
    description: z.string().optional(),
  })).optional(),
  // Accept an explicit `primaryOutputDirectory: null` (a ManualApprovalStep /
  // output-less step legitimately declares it) and normalize it to `undefined`.
  // Without `.nullish()` a present YAML `null` fails the bare string check and
  // 400s the whole upload.
  primaryOutputDirectory: z.string().nullish().transform((v) => v ?? undefined),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  dockerfile: z.string().optional(),
  installCommands: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  buildArgs: z.record(z.string(), z.string()).optional(),
  requiredMetadata: z.array(z.string()).optional(),
  requiredVars: z.array(z.string()).optional(),
  // Kept as free-string maps rather than a value enum: shipped specs use both
  // `bool` and `boolean`, and the coercion-vs-declared-type consistency is
  // enforced separately by the template contract check. The schema only
  // guarantees they're string-valued records here.
  metadataTypes: z.record(z.string(), z.string()).optional(),
  varsTypes: z.record(z.string(), z.string()).optional(),
  // A command the build tooling runs against the built image
  // (build-plugin-images.sh, test-plugins.sh --build, `plugin test`).
  smokeTest: z.string().optional(),
  // Documentation + trust metadata (W0.2). The README is NOT a spec field — it
  // is README.md at the zip root.
  license: z.string().refine(isAllowedSpdxId, {
    message: 'must be a supported SPDX license identifier (e.g. Apache-2.0, MIT)',
  }).optional(),
  changelog: z.string().refine((v) => new TextEncoder().encode(v).length <= PLUGIN_CHANGELOG_MAX_BYTES, {
    message: `must be at most ${PLUGIN_CHANGELOG_MAX_BYTES} bytes`,
  }).optional(),
  homepageUrl: ProjectUrlSchema.optional(),
  sourceUrl: ProjectUrlSchema.optional(),
  // Catalog metadata (§3.1a, G53): the card one-liner and the docs link. Same
  // validators as a value typed into the upload form.
  summary: PLUGIN_CATALOG_FIELD_SCHEMAS.summary.optional(),
  documentationUrl: ProjectUrlSchema.optional(),
  icon: z.union([
    IconKeySchema,
    z.object({ key: IconKeySchema, badge: IconKeySchema.optional() }).strict(),
  ]).optional(),
  network: z.object({
    egress: z.array(z.string().refine(isValidEgressHost, {
      message: 'must be a bare hostname (no scheme, port or path; one leading *. allowed)',
    })).max(EGRESS_MAX_HOSTS).optional(),
  }).strict().optional(),
}).strict();
export type PluginSpecInput = z.infer<typeof PluginSpecSchema>;

/**
 * Result of checking a parsed YAML document against a package schema:
 * `issues` are the individual problems, `message` the one-line form the upload
 * API reports (`plugin-spec.yaml: <path>: <problem>; …`).
 */
export type PackageCheck<T> = { ok: true; value: T } | { ok: false; issues: string[]; message: string };

const isMapping = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

function checkAgainst<T>(file: string, raw: unknown, schema: z.ZodType<T>, withPath: boolean): PackageCheck<T> {
  if (!isMapping(raw)) {
    const message = `${file} must be a YAML mapping`;
    return { ok: false, issues: [message], message };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map(i => (withPath ? `${i.path.join('.') || '(root)'}: ${i.message}` : i.message));
  return { ok: false, issues, message: `${file}: ${issues.join('; ')}` };
}

/** Check a parsed `plugin-spec.yaml` document against {@link PluginSpecSchema}. */
export function checkPluginSpec(raw: unknown): PackageCheck<PluginSpecInput> {
  return checkAgainst('plugin-spec.yaml', raw, PluginSpecSchema, true);
}

/** Check a parsed `config.yaml` document against {@link PluginConfigSchema}. */
export function checkPluginConfig(raw: unknown): PackageCheck<PluginConfigInput> {
  return checkAgainst('config.yaml', raw, PluginConfigSchema, false);
}

/**
 * The required-field contract: `name` and `version` always, `commands` for
 * every type except `ManualApprovalStep`. Returns the upload's message, or null.
 */
export function pluginSpecRequiredFieldsProblem(spec: Pick<PluginSpecInput, 'name' | 'version' | 'commands' | 'pluginType'>): string | null {
  const isApprovalStep = spec.pluginType === 'ManualApprovalStep';
  if (!spec.name || !spec.version || (!isApprovalStep && !spec.commands)) {
    return 'Invalid spec: name, version, and commands are required';
  }
  return null;
}
