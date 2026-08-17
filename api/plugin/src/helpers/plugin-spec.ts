// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs/promises';
import path from 'path';

import { ValidationError } from '@pipeline-builder/api-core';
import type { PluginSpec } from '@pipeline-builder/pipeline-core';
import { validateTemplates, allowedScopeRoots, tokenize } from '@pipeline-builder/pipeline-core';
import { v7 as uuid } from 'uuid';
import YAML from 'yaml';
import { z } from 'zod';


import { getBuildStrategy } from './build-strategy.js';
import { BUILD_TEMP_ROOT } from './docker-build.js';
import type { BuildType } from './docker-build.js';
import type { PluginConfig } from './plugin-helpers.js';
import { validateSafePath } from './safe-path.js';
import { readAndExtractZip } from './zip-extract.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Parsed and validated result from a plugin ZIP. */
export interface ParsedPlugin {
  pluginSpec: PluginSpec;
  /** Extracted directory containing the plugin source. */
  extractDir: string;
  /** Validated Dockerfile path relative to extractDir. */
  dockerfile: string;
  /** Raw Dockerfile content (for DB storage), or null if missing. */
  dockerfileContent: string | null;
  /** Build type from config.yaml (defaults to 'build_image'). */
  buildType: BuildType;
}

// -----------------------------------------------------------------------------
// Bounded YAML parse (billion-laughs / oversized-input defense)
// -----------------------------------------------------------------------------

/**
 * Max YAML text length (bytes) accepted for config.yaml / plugin-spec.yaml.
 * Bounds memory before parsing. Default 1 MiB — plugin manifests are small.
 */
const MAX_YAML_BYTES = parseInt(process.env.PLUGIN_MAX_YAML_BYTES || '1048576', 10);

/**
 * Parse YAML with an input-length cap and a bounded alias count. The `yaml`
 * library defaults `maxAliasCount` to 100; we set it explicitly so an
 * alias-expansion ("billion laughs") bomb can't blow up memory regardless of
 * the library default. `label` names the source for error messages.
 */
function parseBoundedYaml(text: string, label: string): unknown {
  if (text.length > MAX_YAML_BYTES) {
    throw new ValidationError(`${label} exceeds the maximum allowed size (${MAX_YAML_BYTES} bytes)`);
  }
  return YAML.parse(text, { maxAliasCount: 100 });
}

// -----------------------------------------------------------------------------
// Config schema (Zod)
// -----------------------------------------------------------------------------

const PluginConfigSchema = z.object({
  pluginSpec: z.string().optional(),
  dockerfile: z.string().optional(),
  buildType: z.enum(['build_image', 'prebuilt', 'metadata_only']).optional(),
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

/** Parse and validate config.yaml text. */
function parsePluginConfig(configText: string | undefined): PluginConfig {
  if (!configText) return {};

  const raw = parseBoundedYaml(configText, 'config.yaml');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('config.yaml must be a YAML mapping');
  }

  const result = PluginConfigSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map(i => i.message).join('; ');
    throw new ValidationError(`config.yaml: ${msg}`);
  }

  const { data } = result;
  return {
    pluginSpec: data.pluginSpec ? validateSafePath('pluginSpec', data.pluginSpec) : undefined,
    dockerfile: data.dockerfile ? validateSafePath('dockerfile', data.dockerfile) : undefined,
    buildType: data.buildType,
  };
}

// -----------------------------------------------------------------------------
// Plugin spec schema (Zod)
// -----------------------------------------------------------------------------

// name/version/commands are the required-field contract, but they're validated
// by the explicit presence check in parsePluginZip (which yields the stable
// "name, version, and commands are required" message and the ManualApprovalStep
// carve-out). Here they're optional strings; the schema's job is to reject
// malformed *types* on the fields that flow downstream unchecked today —
// pluginType/computeType/timeout/failureBehavior/env/secrets, etc.
const PluginSpecSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  category: z.string().optional(),
  version: z.string().optional(),
  pluginType: z.enum(['CodeBuildStep', 'ShellStep', 'ManualApprovalStep']).optional(),
  computeType: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'X2_LARGE']).optional(),
  // >= 0 minutes: ManualApprovalStep specs legitimately declare `timeout: 0`.
  timeout: z.number().int().nonnegative().optional(),
  failureBehavior: z.enum(['fail', 'warn', 'ignore']).optional(),
  secrets: z.array(z.object({
    name: z.string().min(1),
    required: z.boolean(),
    description: z.string().optional(),
  })).optional(),
  primaryOutputDirectory: z.string().optional(),
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
  // enforced separately in validatePluginTemplates. The schema only guarantees
  // they're string-valued records here.
  metadataTypes: z.record(z.string(), z.string()).optional(),
  varsTypes: z.record(z.string(), z.string()).optional(),
  // Not on the PluginSpec interface, but ~15 shipped specs declare a top-level
  // `smokeTest:` string consumed by the build tooling (build-plugin-images.sh).
  // Allow it so `.strict()` doesn't reject those real plugins.
  smokeTest: z.string().optional(),
}).strict();

/** Parse plugin-spec.yaml text: bounded YAML + strict schema validation. */
function parsePluginSpec(specText: string): PluginSpec {
  const raw = parseBoundedYaml(specText, 'plugin-spec.yaml');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('plugin-spec.yaml must be a YAML mapping');
  }
  const result = PluginSpecSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`plugin-spec.yaml: ${msg}`);
  }
  return result.data as PluginSpec;
}

// -----------------------------------------------------------------------------
// Main parser
// -----------------------------------------------------------------------------

/**
 * Parse, validate, and extract a plugin ZIP archive in a single pass.
 * Opens the ZIP once: reads config + spec as text, extracts all files to disk.
 */
export async function parsePluginZip(zipPath: string): Promise<ParsedPlugin> {
  const extractDir = path.join(BUILD_TEMP_ROOT, uuid());
  await fs.mkdir(extractDir, { recursive: true });

  try {
    // --- Single-pass: extract all + capture text entries ---------------------
    const textEntries = ['config.yaml', 'config.yml', 'plugin-spec.yaml'];
    const texts = await readAndExtractZip(zipPath, textEntries, extractDir);

    // --- Config -------------------------------------------------------------
    const config = parsePluginConfig(texts.get('config.yaml') ?? texts.get('config.yml'));
    const buildType: BuildType = config.buildType ?? 'build_image';

    // --- Spec ---------------------------------------------------------------
    const specPath = config.pluginSpec ?? 'plugin-spec.yaml';
    const specText = texts.get(specPath)
      ?? (specPath !== 'plugin-spec.yaml' ? await fs.readFile(path.join(extractDir, specPath), 'utf-8').catch(() => null) : null);

    if (!specText) {
      throw new ValidationError('plugin-spec.yaml file missing in ZIP');
    }

    const pluginSpec = parsePluginSpec(specText);
    const isApprovalStep = pluginSpec.pluginType === 'ManualApprovalStep';

    if (!pluginSpec.name || !pluginSpec.version || (!isApprovalStep && !pluginSpec.commands)) {
      throw new ValidationError('Invalid spec: name, version, and commands are required');
    }

    // --- Template validation: batch-check all {{ ... }} tokens ----------------
    validatePluginTemplates(pluginSpec);

    // --- Per-build-type validation + Dockerfile resolution ------------------
    const { dockerfile, dockerfileContent } = await getBuildStrategy(buildType)
      .validateAndResolve({ extractDir, config, pluginSpec, isApprovalStep });

    return { pluginSpec, extractDir, dockerfile, dockerfileContent, buildType };
  } catch (err) {
    // Clean up extracted files on any validation failure
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Template validation
// -----------------------------------------------------------------------------

const PLUGIN_SCOPE_ROOTS = ['pipeline', 'plugin', 'env'];
const PLUGIN_TEMPLATABLE_FIELDS = ['description', 'commands', 'installCommands', 'env', 'buildArgs'];

const isPluginTemplatable = (field: string) =>
  PLUGIN_TEMPLATABLE_FIELDS.some(f => field === f || field.startsWith(`${f}[`) || field.startsWith(`${f}.`));

const isPluginPath = allowedScopeRoots(PLUGIN_SCOPE_ROOTS);

/**
 * Batch-validate all `{{ ... }}` template tokens in a plugin spec.
 *
 * Checks:
 *  - Parse errors (unclosed braces, bad filter, etc.)
 *  - Unknown scope root (only `pipeline`, `plugin`, `env` are allowed)
 *  - Reserved `secrets.*` path
 *  - Plugin contract: every `{{ pipeline.metadata.X }}` must have `X` declared
 *    in `requiredMetadata`, and every `{{ pipeline.vars.X }}` must be declared
 *    in `requiredVars` — unless the template uses the `| default:` filter.
 */
export function validatePluginTemplates(pluginSpec: PluginSpec): void {
  const docForScan = {
    description: pluginSpec.description,
    commands: pluginSpec.commands,
    installCommands: pluginSpec.installCommands,
    env: pluginSpec.env,
    buildArgs: pluginSpec.buildArgs,
  };

  const { valid, errors } = validateTemplates(docForScan, isPluginTemplatable, isPluginPath);
  if (!valid) {
    const msg = `Template validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n` +
      errors.map(e => `  • [${e.field}${e.line ? `:${e.line}:${e.col}` : ''}] ${e.message}`).join('\n');
    throw new ValidationError(msg);
  }

  // Contract validation: every referenced pipeline.metadata.X / pipeline.vars.X
  // must be in requiredMetadata / requiredVars (unless a default: is present)
  const requiredMetadata = new Set(pluginSpec.requiredMetadata ?? []);
  const requiredVars = new Set(pluginSpec.requiredVars ?? []);
  const metadataTypes = pluginSpec.metadataTypes ?? {};
  const varsTypes = pluginSpec.varsTypes ?? {};
  const missing: string[] = [];
  const typeMismatches: string[] = [];

  const scanStrings: string[] = [];
  if (pluginSpec.description) scanStrings.push(pluginSpec.description);
  if (pluginSpec.commands) scanStrings.push(...pluginSpec.commands);
  if (pluginSpec.installCommands) scanStrings.push(...pluginSpec.installCommands);
  if (pluginSpec.env) scanStrings.push(...Object.values(pluginSpec.env));
  if (pluginSpec.buildArgs) scanStrings.push(...Object.values(pluginSpec.buildArgs));

  // Map coercion filter → declared-type requirement
  const coerceToType: Record<string, string> = { number: 'number', bool: 'bool', json: 'json' };

  for (const s of scanStrings) {
    if (typeof s !== 'string' || !s.includes('{{')) continue;
    let tokens;
    try { tokens = tokenize(s); } catch { continue; /* parser error already reported */ }
    for (const t of tokens) {
      if (t.kind !== 'expr') continue;

      const isMetadata = t.path[0] === 'pipeline' && t.path[1] === 'metadata' && t.path[2];
      const isVars = t.path[0] === 'pipeline' && t.path[1] === 'vars' && t.path[2];
      if (!isMetadata && !isVars) continue;

      const key = t.path[2]!;
      const kindPath = isMetadata ? `pipeline.metadata.${key}` : `pipeline.vars.${key}`;

      // Contract: key must be declared (default: waives the requirement)
      if (t.defaultValue === undefined) {
        const declared = isMetadata ? requiredMetadata.has(key) : requiredVars.has(key);
        if (!declared) missing.push(kindPath);
      }

      // Type check: if a coercion filter is present, declared type must match
      if (t.coerce) {
        const typeMap = isMetadata ? metadataTypes : varsTypes;
        const declaredType = typeMap[key] ?? 'string';
        const expectedType = coerceToType[t.coerce];
        if (expectedType && declaredType !== expectedType) {
          typeMismatches.push(
            `${kindPath} uses '| ${t.coerce}' but declared type is '${declaredType}' (add '${key}: ${expectedType}' to ${isMetadata ? 'metadataTypes' : 'varsTypes'})`,
          );
        }
      }
    }
  }

  const problems: string[] = [];
  if (missing.length) {
    const uniq = Array.from(new Set(missing)).sort();
    problems.push(
      'Plugin spec uses template paths not declared in contract:\n' +
      uniq.map(p => `  • ${p} — declare it in 'requiredMetadata' or 'requiredVars'`).join('\n'),
    );
  }
  if (typeMismatches.length) {
    const uniq = Array.from(new Set(typeMismatches)).sort();
    problems.push(
      'Plugin spec has type mismatches between coercion filters and declared types:\n' +
      uniq.map(p => `  • ${p}`).join('\n'),
    );
  }
  if (problems.length) throw new ValidationError(problems.join('\n\n'));
}

/**
 * Validate Docker build arguments.
 * Must be a plain object with string keys/values, max 20 entries,
 * keys up to 1000 characters and values up to 4096 characters.
 *
 * @param buildArgs - Build arguments to validate
 * @throws ValidationError if build arguments are invalid
 */
export function validateBuildArgs(buildArgs: unknown): asserts buildArgs is Record<string, string> {
  if (buildArgs === undefined || buildArgs === null) return;
  if (typeof buildArgs !== 'object' || Array.isArray(buildArgs)) {
    throw new ValidationError('buildArgs must be a plain object');
  }
  const entries = Object.entries(buildArgs as Record<string, unknown>);
  if (entries.length > 20) {
    throw new ValidationError('buildArgs cannot have more than 20 entries');
  }
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new ValidationError('buildArgs keys and values must be strings');
    }
    if (key.length > 1000) {
      throw new ValidationError(`buildArgs key exceeds 1000 characters: ${key.slice(0, 50)}...`);
    }
    if (value.length > 4096) {
      throw new ValidationError(`buildArgs value for "${key}" exceeds 4096 characters`);
    }
  }
}
