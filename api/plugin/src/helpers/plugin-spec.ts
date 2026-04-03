import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';

import { ValidationError } from '@mwashburn160/api-core';
import type { PluginSpec } from '@mwashburn160/pipeline-core';
import AdmZip from 'adm-zip';
import { v7 as uuid } from 'uuid';
import YAML from 'yaml';

import { BUILD_TEMP_ROOT } from './docker-build';
import type { BuildType } from './docker-build';
import { generateImageTag } from './plugin-helpers';
import type { PluginConfig } from './plugin-helpers';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Parsed and validated result from a plugin ZIP. */
export interface ParsedPlugin {
  spec: PluginSpec;
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
  /** Path to image tar within extractDir (only for load_image). */
  imageTarPath: string | null;
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
// Config parsing
// -----------------------------------------------------------------------------

const VALID_CONFIG_KEYS = new Set(['spec', 'dockerfile', 'buildType', 'imageTar']);
const VALID_TAR_EXTENSIONS = ['.tar', '.tar.gz', '.tgz'];

/** Parse and validate config.yaml from the ZIP root (optional). */
function parsePluginConfig(zip: AdmZip): PluginConfig {
  const configEntry = zip.getEntry('config.yaml') || zip.getEntry('config.yml');
  if (!configEntry) {
    return {};
  }

  const raw = YAML.parse(zip.readAsText(configEntry));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('config.yaml must be a YAML mapping');
  }

  // Reject unknown keys
  for (const key of Object.keys(raw)) {
    if (!VALID_CONFIG_KEYS.has(key)) {
      throw new ValidationError(`config.yaml: unknown key '${key}'`);
    }
  }

  const config: PluginConfig = {};

  if (raw.spec !== undefined) {
    if (typeof raw.spec !== 'string') throw new ValidationError('config.yaml: spec must be a string');
    config.spec = validateSafePath('spec', raw.spec);
  }

  if (raw.dockerfile !== undefined) {
    if (typeof raw.dockerfile !== 'string') throw new ValidationError('config.yaml: dockerfile must be a string');
    config.dockerfile = validateSafePath('dockerfile', raw.dockerfile);
  }

  if (raw.buildType !== undefined) {
    if (raw.buildType !== 'build_image' && raw.buildType !== 'load_image') {
      throw new ValidationError('config.yaml: buildType must be "build_image" or "load_image"');
    }
    config.buildType = raw.buildType;
  }

  if (raw.imageTar !== undefined) {
    if (typeof raw.imageTar !== 'string') throw new ValidationError('config.yaml: imageTar must be a string');
    config.imageTar = validateSafePath('imageTar', raw.imageTar);
  }

  // Cross-field validation
  const buildType = config.buildType ?? 'build_image';
  if (buildType === 'load_image' && config.dockerfile) {
    throw new ValidationError('config.yaml: dockerfile is not allowed when buildType is load_image');
  }
  if (buildType === 'build_image' && config.imageTar) {
    throw new ValidationError('config.yaml: imageTar is not allowed when buildType is build_image');
  }
  if (buildType === 'load_image' && !config.imageTar) {
    throw new ValidationError('config.yaml: imageTar is required when buildType is load_image');
  }

  return config;
}

// -----------------------------------------------------------------------------
// Main parser
// -----------------------------------------------------------------------------

/**
 * Parse, validate, and extract a plugin ZIP archive.
 *
 * @param zipPath - Path to the uploaded ZIP file
 * @returns Parsed plugin with extracted directory and metadata
 * @throws Error with a user-facing message on validation failure
 */
export async function parsePluginZip(zipPath: string): Promise<ParsedPlugin> {
  const zip = new AdmZip(zipPath);

  // --- Config (optional) ---------------------------------------------------
  const config = parsePluginConfig(zip);
  const buildType: BuildType = config.buildType ?? 'build_image';

  // --- Spec ----------------------------------------------------------------
  const specPath = config.spec ?? 'spec.yaml';
  const specEntry = zip.getEntry(specPath);
  if (!specEntry) {
    throw new ValidationError('spec.yaml file missing in ZIP');
  }

  const spec: PluginSpec = YAML.parse(zip.readAsText(specEntry));

  const isApprovalStep = spec.pluginType === 'ManualApprovalStep';

  if (!spec.name || !spec.version || (!isApprovalStep && !spec.commands)) {
    throw new ValidationError('Invalid spec: name, version, and commands are required');
  }

  // Reject buildArgs for load_image (meaningless without a build step)
  if (buildType === 'load_image' && spec.buildArgs && Object.keys(spec.buildArgs).length > 0) {
    throw new ValidationError('buildArgs are not allowed when buildType is load_image');
  }

  // --- Extract -------------------------------------------------------------
  const extractDir = path.join(BUILD_TEMP_ROOT, uuid());
  await fs.mkdir(extractDir, { recursive: true });
  zip.extractAllTo(extractDir, true);

  // --- Dockerfile / image tar validation -----------------------------------
  let dockerfile = '';
  let dockerfileContent: string | null = null;
  let imageTarPath: string | null = null;

  if (buildType === 'load_image') {
    // Validate image tar
    const tarFile = config.imageTar!;
    if (!VALID_TAR_EXTENSIONS.some((ext) => tarFile.endsWith(ext))) {
      throw new ValidationError(`Invalid imageTar: must end in ${VALID_TAR_EXTENSIONS.join(', ')}`);
    }
    const tarFullPath = path.join(extractDir, tarFile);
    if (!existsSync(tarFullPath)) {
      throw new ValidationError(`imageTar file not found in ZIP: ${tarFile}`);
    }
    const realTarPath = await fs.realpath(tarFullPath);
    if (!realTarPath.startsWith(extractDir + path.sep)) {
      throw new ValidationError('Invalid imageTar path: resolves outside extraction directory');
    }
    imageTarPath = tarFile;
  } else if (!isApprovalStep) {
    // Dockerfile validation (build_image)
    const rawDockerfile = config.dockerfile ?? spec.dockerfile ?? 'Dockerfile';
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

  // --- Image tag -----------------------------------------------------------
  const imageTag = generateImageTag(spec.name);

  return { spec, extractDir, dockerfile, dockerfileContent, imageTag, buildType, imageTarPath };
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
