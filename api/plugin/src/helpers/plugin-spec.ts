// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs/promises';
import path from 'path';

import {
  ValidationError, checkPluginConfig, checkPluginSpec, checkPluginTemplates, formatPluginTemplateIssue,
  pluginSpecRequiredFieldsProblem, type PluginTemplateEngine, type PluginTemplateIssue,
} from '@pipeline-builder/api-core';
import type { PluginSpec } from '@pipeline-builder/pipeline-core';
import { validateTemplates, allowedScopeRoots, tokenize } from '@pipeline-builder/pipeline-core';
import type { PluginContractValueType } from '@pipeline-builder/pipeline-data';
import { v7 as uuid } from 'uuid';
import YAML from 'yaml';


import { getBuildStrategy } from './build-strategy.js';
import { BUILD_TEMP_ROOT } from './docker-build.js';
import type { BuildType } from './docker-build.js';
import type { PluginConfig, PluginContractFields } from './plugin-helpers.js';
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
  /**
   * README.md from the zip root, or null when absent. Not size-checked here: it
   * is a DETECTED catalog value, so an oversized README is shown blank with the
   * reason (catalog-metadata.ts) rather than failing the upload. Rendered to
   * sanitized HTML only once the user has accepted or edited it.
   */
  readmeMd: string | null;
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
// config.yaml + plugin-spec.yaml (schemas shared with the CLI from api-core)
// -----------------------------------------------------------------------------

/** Parse and validate config.yaml text. */
function parsePluginConfig(configText: string | undefined): PluginConfig {
  if (!configText) return {};

  const result = checkPluginConfig(parseBoundedYaml(configText, 'config.yaml'));
  if (!result.ok) throw new ValidationError(result.message);

  const data = result.value;
  return {
    pluginSpec: data.pluginSpec ? validateSafePath('pluginSpec', data.pluginSpec) : undefined,
    dockerfile: data.dockerfile ? validateSafePath('dockerfile', data.dockerfile) : undefined,
    buildType: data.buildType,
  };
}

/** Parse plugin-spec.yaml text: bounded YAML + strict schema validation. */
function parsePluginSpec(specText: string): PluginSpec {
  const result = checkPluginSpec(parseBoundedYaml(specText, 'plugin-spec.yaml'));
  if (!result.ok) throw new ValidationError(result.message);
  return result.value as PluginSpec;
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
    const textEntries = ['config.yaml', 'config.yml', 'plugin-spec.yaml', 'README.md'];
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

    const requiredProblem = pluginSpecRequiredFieldsProblem(pluginSpec);
    if (requiredProblem) throw new ValidationError(requiredProblem);

    // --- Template validation: batch-check all {{ ... }} tokens ----------------
    validatePluginTemplates(pluginSpec);

    // --- Per-build-type validation + Dockerfile resolution ------------------
    const { dockerfile, dockerfileContent } = await getBuildStrategy(buildType)
      .validateAndResolve({ extractDir, config, pluginSpec, isApprovalStep });

    // --- README (zip root) --------------------------------------------------
    // A detected catalog value (§3.1a): validated, then rendered to sanitized
    // HTML once accepted or edited (catalog-metadata.ts), so no read path ever
    // renders untrusted markdown (G6).
    const readmeMd = texts.get('README.md') ?? null;

    return { pluginSpec, extractDir, dockerfile, dockerfileContent, buildType, readmeMd };
  } catch (err) {
    // Clean up extracted files on any validation failure
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Persisted contract + documentation fields
// -----------------------------------------------------------------------------

/**
 * Normalize a declared coercion-type map for storage. Shipped specs spell the
 * boolean type both `bool` and `boolean`; the stored contract uses `bool` (the
 * filter name). Unknown spellings fall back to `string`, the undeclared default.
 */
function normalizeContractTypes(types: Record<string, string> | undefined): Record<string, PluginContractValueType> {
  const out: Record<string, PluginContractValueType> = {};
  for (const [key, raw] of Object.entries(types ?? {})) {
    const t = raw === 'boolean' ? 'bool' : raw;
    out[key] = t === 'number' || t === 'bool' || t === 'json' ? t : 'string';
  }
  return out;
}

/**
 * The execution-CONTRACT columns for a parsed plugin (W0.2): what the spec
 * declares about how the plugin runs, persisted rather than validated and
 * dropped. Spec-only and never editable (G56). The descriptive catalog columns
 * come from `catalogColumns` (catalog-metadata.ts) after accept-or-edit.
 */
export function specContractFields(spec: PluginSpec): PluginContractFields {
  return {
    requiredMetadata: spec.requiredMetadata ?? [],
    requiredVars: spec.requiredVars ?? [],
    metadataTypes: normalizeContractTypes(spec.metadataTypes),
    varsTypes: normalizeContractTypes(spec.varsTypes),
    smokeTest: spec.smokeTest ?? null,
    networkEgress: spec.network?.egress ?? [],
  };
}

// -----------------------------------------------------------------------------
// Template validation
// -----------------------------------------------------------------------------

/** pipeline-core's template engine, for api-core's shared contract check. */
const TEMPLATE_ENGINE: PluginTemplateEngine = { validateTemplates, allowedScopeRoots, tokenize };

/**
 * Refuse an upload whose `{{ ... }}` templates break the plugin contract — the
 * shared api-core {@link checkPluginTemplates} (the CLI runs the same check),
 * thrown as one {@link ValidationError} grouped by kind.
 */
export function validatePluginTemplates(pluginSpec: PluginSpec): void {
  const issues = checkPluginTemplates(pluginSpec, TEMPLATE_ENGINE);
  if (!issues.length) return;
  const list = (kind: PluginTemplateIssue['kind']) =>
    issues.filter((i) => i.kind === kind).map((i) => `  • ${formatPluginTemplateIssue(i)}`);
  const sections: Array<[string, string[]]> = [
    ['Template validation failed', list('template')],
    ['Plugin spec uses template paths not declared in contract', list('undeclared')],
    ['Plugin spec has type mismatches between coercion filters and declared types', list('type-mismatch')],
  ];
  throw new ValidationError(sections
    .filter(([, lines]) => lines.length)
    .map(([title, lines]) => `${title} (${lines.length}):\n${lines.join('\n')}`)
    .join('\n\n'));
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
