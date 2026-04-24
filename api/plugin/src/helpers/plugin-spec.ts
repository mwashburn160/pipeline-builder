// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createWriteStream, existsSync } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';

import { ValidationError } from '@pipeline-builder/api-core';
import type { PluginSpec } from '@pipeline-builder/pipeline-core';
import { validateTemplates, allowedScopeRoots } from '@pipeline-builder/pipeline-core';
import { v7 as uuid } from 'uuid';
import YAML from 'yaml';
import yauzl from 'yauzl';
import { z } from 'zod';

import { BUILD_TEMP_ROOT } from './docker-build';
import type { BuildType } from './docker-build';
import { generateImageTag } from './plugin-helpers';
import type { PluginConfig } from './plugin-helpers';

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
  /** Generated image tag (lowercase, safe characters only). */
  imageTag: string;
  /** Build type from config.yaml (defaults to 'build_image'). */
  buildType: BuildType;
}

// -----------------------------------------------------------------------------
// Path validation
// -----------------------------------------------------------------------------

/** Validate a path from config/spec does not contain traversal or absolute references. */
function validateSafePath(label: string, rawPath: string): string {
  const normalized = path.normalize(rawPath);
  if (
    normalized.includes('\0') ||
    normalized.includes('..') ||
    path.isAbsolute(normalized) ||
    normalized.includes(path.sep + path.sep) ||
    normalized.startsWith(path.sep)
  ) {
    throw new ValidationError(`Invalid ${label} path: must not contain path traversal or be absolute`);
  }
  return normalized;
}

// -----------------------------------------------------------------------------
// ZIP helpers (streaming via yauzl)
// -----------------------------------------------------------------------------

/** Read specific text entries and extract all files in a single pass. */
async function readAndExtractZip(
  zipPath: string,
  textEntries: string[],
  extractDir: string,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const wanted = new Set(textEntries);

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        const targetPath = path.join(extractDir, entry.fileName);

        // Prevent path traversal
        if (!targetPath.startsWith(extractDir + path.sep) && targetPath !== extractDir) {
          return reject(new ValidationError(`ZIP entry escapes target directory: ${entry.fileName}`));
        }

        if (entry.fileName.endsWith('/')) {
          fs.mkdir(targetPath, { recursive: true }).then(() => zipfile.readEntry()).catch(reject);
          return;
        }

        // Stream file to disk
        fs.mkdir(path.dirname(targetPath), { recursive: true })
          .then(() => {
            zipfile.openReadStream(entry, (streamErr, stream) => {
              if (streamErr) return reject(streamErr);

              if (wanted.has(entry.fileName)) {
                // Capture text content AND write to disk
                const chunks: Buffer[] = [];
                const writeStream = createWriteStream(targetPath);
                stream.on('data', (chunk: Buffer) => { chunks.push(chunk); writeStream.write(chunk); });
                stream.on('end', () => {
                  writeStream.end();
                  results.set(entry.fileName, Buffer.concat(chunks).toString('utf-8'));
                  zipfile.readEntry();
                });
                stream.on('error', reject);
              } else {
                // Just write to disk
                const writeStream = createWriteStream(targetPath);
                pipeline(stream, writeStream)
                  .then(() => zipfile.readEntry())
                  .catch(reject);
              }
            });
          })
          .catch(reject);
      });

      zipfile.on('end', () => { zipfile.close(); resolve(results); });
      zipfile.on('error', reject);
    });
  });
}

// -----------------------------------------------------------------------------
// Config schema (Zod)
// -----------------------------------------------------------------------------

const PluginConfigSchema = z.object({
  pluginSpec: z.string().optional(),
  dockerfile: z.string().optional(),
  buildType: z.enum(['build_image', 'prebuilt', 'metadata_only']).optional(),
  imageTag: z.string().regex(/^p-[a-z0-9]+-[a-f0-9]{12}$/, 'imageTag must match p-{name}-{hash12}').optional(),
}).strict()
  .refine(d => !(d.buildType === 'prebuilt' && d.dockerfile), {
    message: 'dockerfile is not allowed when buildType is prebuilt',
  })
  .refine(d => !(d.buildType === 'prebuilt' && !d.imageTag), {
    message: 'imageTag is required when buildType is prebuilt',
  })
  .refine(d => !(d.buildType === 'build_image' && d.imageTag), {
    message: 'imageTag is not allowed when buildType is build_image',
  })
  .refine(d => !(d.buildType === 'metadata_only' && d.dockerfile), {
    message: 'dockerfile is not allowed when buildType is metadata_only',
  })
  .refine(d => !(d.buildType === 'metadata_only' && d.imageTag), {
    message: 'imageTag is not allowed when buildType is metadata_only',
  });

/** Parse and validate config.yaml text. */
function parsePluginConfig(configText: string | undefined): PluginConfig {
  if (!configText) return {};

  const raw = YAML.parse(configText);
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
    imageTag: data.imageTag,
  };
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

    const pluginSpec: PluginSpec = YAML.parse(specText);
    const isApprovalStep = pluginSpec.pluginType === 'ManualApprovalStep';

    if (!pluginSpec.name || !pluginSpec.version || (!isApprovalStep && !pluginSpec.commands)) {
      throw new ValidationError('Invalid spec: name, version, and commands are required');
    }

    // --- Template validation: batch-check all {{ ... }} tokens ----------------
    validatePluginTemplates(pluginSpec);

    // --- Dockerfile validation (build_image only) ---------------------------
    let dockerfile = '';
    let dockerfileContent: string | null = null;

    if (buildType === 'build_image' && !isApprovalStep) {
      const rawDockerfile = config.dockerfile ?? pluginSpec.dockerfile ?? 'Dockerfile';
      dockerfile = validateSafePath('dockerfile', rawDockerfile);

      const dockerfilePath = path.join(extractDir, dockerfile);
      const realDockerfilePath = existsSync(dockerfilePath)
        ? await fs.realpath(dockerfilePath)
        : null;

      if (realDockerfilePath && !realDockerfilePath.startsWith(extractDir + path.sep)) {
        throw new ValidationError('Invalid dockerfile path: resolves outside extraction directory');
      }

      dockerfileContent = realDockerfilePath
        ? await fs.readFile(realDockerfilePath, 'utf-8')
        : null;
    }

    // --- Prebuilt validation: image.tar must exist in ZIP --------------------
    if (buildType === 'prebuilt' && !existsSync(path.join(extractDir, 'image.tar'))) {
      throw new ValidationError('image.tar is required in ZIP when buildType is prebuilt');
    }

    // --- Image tag (not needed for metadata_only) ----------------------------
    const imageTag = buildType === 'metadata_only'
      ? ''
      : (config.imageTag ?? generateImageTag(pluginSpec.name));

    return { pluginSpec, extractDir, dockerfile, dockerfileContent, imageTag, buildType };
  } catch (err) {
    // Clean up extracted files on any validation failure
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Build args validation
// -----------------------------------------------------------------------------

/**
 * Validate Docker build arguments.
 * Must be a plain object with string keys/values, max 20 entries,
 * and max 1000 characters per key/value.
 *
 * @param buildArgs - Build arguments to validate
 * @throws ValidationError if build arguments are invalid
 */
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
  const spec = pluginSpec as unknown as {
    description?: string;
    commands?: string[];
    installCommands?: string[];
    env?: Record<string, string>;
    buildArgs?: Record<string, string>;
    requiredMetadata?: string[];
    requiredVars?: string[];
  };

  const docForScan = {
    description: spec.description,
    commands: spec.commands,
    installCommands: spec.installCommands,
    env: spec.env,
    buildArgs: spec.buildArgs,
  };

  const { valid, errors } = validateTemplates(docForScan, isPluginTemplatable, isPluginPath);
  if (!valid) {
    const msg = `Template validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n` +
      errors.map(e => `  • [${e.field}${e.line ? `:${e.line}:${e.col}` : ''}] ${e.message}`).join('\n');
    throw new ValidationError(msg);
  }

  // Contract validation: every referenced pipeline.metadata.X / pipeline.vars.X
  // must be in requiredMetadata / requiredVars (unless a default: is present)
  const requiredMetadata = new Set((pluginSpec as unknown as { requiredMetadata?: string[] }).requiredMetadata ?? []);
  const requiredVars = new Set((pluginSpec as unknown as { requiredVars?: string[] }).requiredVars ?? []);
  const metadataTypes = (pluginSpec as unknown as { metadataTypes?: Record<string, string> }).metadataTypes ?? {};
  const varsTypes = (pluginSpec as unknown as { varsTypes?: Record<string, string> }).varsTypes ?? {};
  const missing: string[] = [];
  const typeMismatches: string[] = [];

  const scanStrings: string[] = [];
  if (spec.description) scanStrings.push(spec.description);
  if (spec.commands) scanStrings.push(...spec.commands);
  if (spec.installCommands) scanStrings.push(...spec.installCommands);
  if (spec.env) scanStrings.push(...Object.values(spec.env));
  if (spec.buildArgs) scanStrings.push(...Object.values(spec.buildArgs));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tokenize } = require('@pipeline-builder/pipeline-core');

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
      `Plugin spec uses template paths not declared in contract:\n` +
      uniq.map(p => `  • ${p} — declare it in 'requiredMetadata' or 'requiredVars'`).join('\n'),
    );
  }
  if (typeMismatches.length) {
    const uniq = Array.from(new Set(typeMismatches)).sort();
    problems.push(
      `Plugin spec has type mismatches between coercion filters and declared types:\n` +
      uniq.map(p => `  • ${p}`).join('\n'),
    );
  }
  if (problems.length) throw new ValidationError(problems.join('\n\n'));
}

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
