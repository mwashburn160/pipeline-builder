// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createWriteStream, existsSync } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';

import { ValidationError } from '@mwashburn160/api-core';
import type { PluginSpec } from '@mwashburn160/pipeline-core';
import { v7 as uuid } from 'uuid';
import yauzl from 'yauzl';
import YAML from 'yaml';
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
