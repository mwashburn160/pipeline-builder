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

  if (!manifest.name || !manifest.version || !manifest.commands) {
    throw new ValidationError('Invalid manifest: name, version, and commands are required');
  }

  // --- Dockerfile path validation -----------------------------------------
  const rawDockerfile = manifest.dockerfile || 'Dockerfile';
  const dockerfile = path.normalize(rawDockerfile);

  if (
    dockerfile.includes('..') ||
    path.isAbsolute(dockerfile) ||
    dockerfile.includes(path.sep + path.sep) ||
    dockerfile.startsWith(path.sep)
  ) {
    throw new ValidationError('Invalid dockerfile path: must not contain path traversal or be absolute');
  }

  // --- Extract -------------------------------------------------------------
  const extractDir = path.join(process.cwd(), 'tmp', uuid());
  fs.mkdirSync(extractDir, { recursive: true });
  zip.extractAllTo(extractDir, true);

  // --- Read Dockerfile for DB storage -------------------------------------
  const dockerfilePath = path.join(extractDir, dockerfile);
  const dockerfileContent = fs.existsSync(dockerfilePath)
    ? fs.readFileSync(dockerfilePath, 'utf-8')
    : null;

  // --- Image tag -----------------------------------------------------------
  const imageTag = `p-${manifest.name.replace(/[^a-z0-9]/gi, '')}-${uuid().slice(0, 8)}`.toLowerCase();

  return { manifest, extractDir, dockerfile, dockerfileContent, imageTag };
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
