/**
 * @module helpers/manifest
 * @description ZIP archive extraction and manifest.yaml validation.
 */

import * as fs from 'fs';
import path from 'path';

import type { PluginManifest } from '@mwashburn160/pipeline-core';
import AdmZip from 'adm-zip';
import { v7 as uuid } from 'uuid';
import YAML from 'yaml';

/** Parsed and validated result from a plugin ZIP. */
export interface ParsedPlugin {
  manifest: PluginManifest;
  /** Extracted directory containing the plugin source. */
  extractDir: string;
  /** Validated Dockerfile path relative to extractDir. */
  dockerfile: string;
  /** Raw Dockerfile content (for DB storage), or null if missing. */
  dockerfileContent: string | null;
  /** Generated image tag (lowercase, safe characters only). */
  imageTag: string;
}

/**
 * Parse, validate, and extract a plugin ZIP archive.
 *
 * @param zipPath - Path to the uploaded ZIP file
 * @returns Parsed plugin with extracted directory and metadata
 * @throws Error with a user-facing message on validation failure
 */
export function parsePluginZip(zipPath: string): ParsedPlugin {
  const zip = new AdmZip(zipPath);

  // --- Manifest -----------------------------------------------------------
  const manifestEntry = zip.getEntry('manifest.yaml') || zip.getEntry('manifest');
  if (!manifestEntry) {
    throw new ValidationError('manifest.yaml file missing in ZIP');
  }

  const manifest: PluginManifest = YAML.parse(zip.readAsText(manifestEntry));

  const isApprovalStep = manifest.pluginType === 'ManualApprovalStep';

  if (!manifest.name || !manifest.version || (!isApprovalStep && !manifest.commands)) {
    throw new ValidationError('Invalid manifest: name, version, and commands are required');
  }

  // --- Extract -------------------------------------------------------------
  const extractDir = path.join(process.cwd(), 'tmp', uuid());
  fs.mkdirSync(extractDir, { recursive: true });
  zip.extractAllTo(extractDir, true);

  // --- Dockerfile path validation (skipped for ManualApprovalStep) --------
  let dockerfile = '';
  let dockerfileContent: string | null = null;

  if (!isApprovalStep) {
    const rawDockerfile = manifest.dockerfile || 'Dockerfile';
    dockerfile = path.normalize(rawDockerfile);

    if (
      dockerfile.includes('\0') ||
      dockerfile.includes('..') ||
      path.isAbsolute(dockerfile) ||
      dockerfile.includes(path.sep + path.sep) ||
      dockerfile.startsWith(path.sep)
    ) {
      throw new ValidationError('Invalid dockerfile path: must not contain path traversal or be absolute');
    }

    // --- Read Dockerfile for DB storage -----------------------------------
    const dockerfilePath = path.join(extractDir, dockerfile);
    const realDockerfilePath = fs.existsSync(dockerfilePath)
      ? fs.realpathSync(dockerfilePath)
      : null;

    // Symlink check: ensure resolved path stays within the extraction directory
    if (realDockerfilePath && !realDockerfilePath.startsWith(extractDir + path.sep)) {
      throw new ValidationError('Invalid dockerfile path: resolves outside extraction directory');
    }

    dockerfileContent = realDockerfilePath
      ? fs.readFileSync(realDockerfilePath, 'utf-8')
      : null;
  }

  // --- Image tag -----------------------------------------------------------
  const prefix = process.env.PLUGIN_IMAGE_PREFIX || 'p-';
  const imageTag = `${prefix}${manifest.name.replace(/[^a-z0-9]/gi, '')}-${uuid().slice(0, 8)}`.toLowerCase();

  return { manifest, extractDir, dockerfile, dockerfileContent, imageTag };
}

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

/**
 * Validation error thrown when the plugin ZIP or manifest is invalid.
 * Route handlers should catch this and return a 400 response.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
