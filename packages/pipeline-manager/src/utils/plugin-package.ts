// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A LOCAL plugin directory (the zip root the platform receives), read and
 * validated with the server's own rules: the spec and config schemas, the
 * required-field contract and the catalog detection all come from api-core, so
 * `plugin validate` / `plugin publish` report exactly what the upload would
 * (plugin-ecosystem W6, §3.1a).
 */

import fs from 'fs';
import path from 'path';
import {
  PLUGIN_NAME_PATTERN, PLUGIN_VERSION_PATTERN, checkPluginConfig, checkPluginSpec, checkPluginTemplates, detectCatalogMetadata,
  formatPluginTemplateIssue, pluginSpecRequiredFieldsProblem, type DetectedField, type PluginBuildType, type PluginSpecInput,
  type PluginTemplateIssue,
} from '@pipeline-builder/api-core';
import YAML from 'yaml';
import { ValidationError } from './error-handler.js';

/** Max YAML text read for config.yaml / plugin-spec.yaml (the server's default bound). */
const MAX_YAML_BYTES = 1024 * 1024;

/** A plugin directory as the upload would see it. */
export interface PluginPackage {
  dir: string;
  buildType: PluginBuildType;
  specFile: string;
  /** The schema-checked spec, or null when the spec failed the schema. */
  spec: PluginSpecInput | null;
  /** The spec document as parsed (before the schema), for fields the schema rejected. */
  rawSpec: Record<string, unknown>;
  dockerfileName: string;
  dockerfileContent: string | null;
  readmeMd: string | null;
  /** Problems found while reading (schema, required fields, build-type prerequisites). */
  problems: string[];
}

function parseYamlFile(file: string, label: string, problems: string[]): unknown {
  const text = fs.readFileSync(file, 'utf-8');
  if (text.length > MAX_YAML_BYTES) {
    problems.push(`${label} exceeds the maximum allowed size (${MAX_YAML_BYTES} bytes)`);
    return undefined;
  }
  try {
    return YAML.parse(text, { maxAliasCount: 100 });
  } catch (err) {
    problems.push(`${label}: invalid YAML (${(err as Error).message.split('\n')[0]})`);
    return undefined;
  }
}

const readIfExists = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);

/**
 * Read and validate a plugin directory. Throws only when the directory or its
 * spec is missing; every other problem is collected in `problems`.
 */
export function readPluginPackage(dirArg: string): PluginPackage {
  const dir = path.resolve(dirArg);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ValidationError(`Not a directory: ${dir}`, 'dir', dir);
  const problems: string[] = [];

  let buildType: PluginBuildType = 'build_image';
  let specFile = 'plugin-spec.yaml';
  let dockerfileName = 'Dockerfile';
  const configPath = ['config.yaml', 'config.yml'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
  if (configPath) {
    const raw = parseYamlFile(configPath, path.basename(configPath), problems);
    if (raw !== undefined && raw !== null) {
      const config = checkPluginConfig(raw);
      if (!config.ok) {
        problems.push(config.message);
      } else {
        buildType = config.value.buildType ?? 'build_image';
        if (config.value.pluginSpec) specFile = config.value.pluginSpec;
        if (config.value.dockerfile) dockerfileName = config.value.dockerfile;
      }
    }
  }
  for (const [label, rel] of [['pluginSpec', specFile], ['dockerfile', dockerfileName]] as const) {
    const resolved = path.resolve(dir, rel);
    if (path.isAbsolute(rel) || !resolved.startsWith(dir + path.sep)) problems.push(`config.yaml: ${label} must be a relative path inside the plugin directory`);
  }

  const specPath = path.join(dir, specFile);
  if (!fs.existsSync(specPath)) throw new ValidationError(`Missing plugin spec: ${specPath}`, 'dir', dir);
  const rawDoc = parseYamlFile(specPath, specFile, problems);
  const rawSpec = rawDoc && typeof rawDoc === 'object' && !Array.isArray(rawDoc) ? rawDoc as Record<string, unknown> : {};
  let spec: PluginSpecInput | null = null;
  if (rawDoc !== undefined) {
    const checked = checkPluginSpec(rawDoc);
    if (checked.ok) spec = checked.value;
    else problems.push(checked.message);
  }

  const view = spec ?? rawSpec as PluginSpecInput;
  const required = pluginSpecRequiredFieldsProblem(view);
  if (required) problems.push(required);
  if (typeof view.name === 'string' && view.name && !PLUGIN_NAME_PATTERN.test(view.name)) {
    problems.push(`${specFile}: name must match ${PLUGIN_NAME_PATTERN}`);
  }
  if (typeof view.version === 'string' && view.version && !PLUGIN_VERSION_PATTERN.test(view.version)) {
    problems.push(`${specFile}: version must be semver (x.y.z)`);
  }

  const isApproval = view.pluginType === 'ManualApprovalStep';
  const dockerfileContent = readIfExists(path.join(dir, dockerfileName));
  if (buildType === 'build_image' && !isApproval && dockerfileContent === null) {
    problems.push(`Dockerfile not found for buildType build_image: ${path.join(dir, dockerfileName)}`);
  }
  if (buildType === 'prebuilt' && !fs.existsSync(path.join(dir, 'image.tar'))) {
    problems.push('image.tar not found for buildType prebuilt');
  }

  return {
    dir,
    buildType,
    specFile,
    spec,
    rawSpec,
    dockerfileName,
    dockerfileContent: buildType === 'build_image' ? dockerfileContent : null,
    readmeMd: readIfExists(path.join(dir, 'README.md')),
    problems,
  };
}

/**
 * `{{ }}` template + plugin-contract problems: api-core's
 * {@link checkPluginTemplates}, the same check the server's upload applies,
 * with pipeline-core's template engine.
 */
export async function templateProblems(spec: Record<string, unknown>): Promise<string[]> {
  const engine = await import('@pipeline-builder/pipeline-core');
  return checkPluginTemplates(spec, engine).map((issue) => `${TEMPLATE_ISSUE_PREFIX[issue.kind]}${formatPluginTemplateIssue(issue)}`);
}

const TEMPLATE_ISSUE_PREFIX: Record<PluginTemplateIssue['kind'], string> = {
  'template': 'template ',
  'undeclared': 'contract: ',
  'type-mismatch': 'contract: ',
};

/** Every problem the upload would refuse: reading, schema, build type, templates. */
export async function packageProblems(pkg: PluginPackage): Promise<string[]> {
  return [...pkg.problems, ...await templateProblems(pkg.rawSpec)];
}

/**
 * The catalog fields as the server will DETECT them (spec → README → the
 * plugin's own Dockerfile labels → derived), with each value's source and any
 * validation error — the same api-core detection the upload runs.
 */
export function detectPackageCatalog(pkg: PluginPackage): DetectedField[] {
  // Detection reads only the descriptive keys. A spec that failed the schema
  // still has them in the raw document, and each is re-validated per field.
  const spec = (pkg.spec ?? pkg.rawSpec) as Parameters<typeof detectCatalogMetadata>[0]['spec'];
  return detectCatalogMetadata({ spec, readmeMd: pkg.readmeMd, dockerfileContent: pkg.dockerfileContent });
}

/** Human-readable source badge (the upload dialog's wording). */
export const SOURCE_LABELS: Record<string, string> = {
  spec: 'Spec', readme: 'README', dockerfile: 'Dockerfile label', derived: 'Generated', user: 'Edited',
};

/** A one-line rendering of a catalog value. */
export function formatCatalogValue(value: unknown, max = 80): string {
  if (value === null || value === undefined) return '(empty)';
  let text: string;
  if (Array.isArray(value)) {text = value.join(', ');} else if (typeof value === 'object') {
    const icon = value as { key?: string; badge?: string };
    text = icon.key ? `${icon.key}${icon.badge ? ` (badge: ${icon.badge})` : ''}` : JSON.stringify(value);
  } else {text = String(value);}
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
