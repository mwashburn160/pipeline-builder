// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import YAML from 'yaml';
import { printCommandHeader } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printError, printSuccess, printWarning, fileExists } from '../utils/output-utils.js';

interface ValidatePluginOptions {
  dir?: string;
}

const PLUGIN_TYPES = ['CodeBuildStep', 'ShellStep', 'ManualApprovalStep'];
const COMPUTE_TYPES = ['SMALL', 'MEDIUM', 'LARGE', 'X2_LARGE'];
const FAILURE_BEHAVIORS = ['fail', 'warn', 'ignore'];
const BUILD_TYPES = ['build_image', 'prebuilt', 'metadata_only'];

/**
 * Register the `validate-plugin` command — run the same structural + `{{ }}`
 * template checks the server's upload path enforces, against a LOCAL plugin
 * directory, so authors catch problems before packaging/uploading. Exits
 * non-zero on any problem (CI-friendly), mirroring `validate-templates`.
 *
 * Usage:
 *   pipeline-manager plugin validate --dir ./my-linter
 */
export function validatePlugin(program: Command): void {
  program
    .command('validate')
    .description('Validate a local plugin directory (config.yaml + plugin-spec.yaml) before upload')
    .requiredOption('--dir <path>', 'Path to the plugin directory')
    .action(async (options: ValidatePluginOptions) => {
      const executionId = printCommandHeader('Validate Plugin');
      try {
        const dir = path.resolve(options.dir ?? '');
        if (!fileExists(dir) || !fs.statSync(dir).isDirectory()) {
          throw new ValidationError(`Not a directory: ${dir}`);
        }

        const problems: string[] = [];

        // config.yaml (optional build manifest).
        const configPath = ['config.yaml', 'config.yml'].map(f => path.join(dir, f)).find(fileExists);
        let buildType = 'build_image';
        let specFile = 'plugin-spec.yaml';
        let dockerfileName = 'Dockerfile';
        if (configPath) {
          const config = (YAML.parse(fs.readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
          if (config.buildType !== undefined) {
            if (typeof config.buildType !== 'string' || !BUILD_TYPES.includes(config.buildType)) {
              problems.push(`config.yaml: buildType must be one of ${BUILD_TYPES.join(', ')}`);
            } else {
              buildType = config.buildType;
            }
          }
          if (typeof config.pluginSpec === 'string') specFile = config.pluginSpec;
          if (typeof config.dockerfile === 'string') dockerfileName = config.dockerfile;
          if ((buildType === 'prebuilt' || buildType === 'metadata_only') && config.dockerfile) {
            problems.push(`config.yaml: dockerfile is not allowed when buildType is ${buildType}`);
          }
        }

        // plugin-spec.yaml (required).
        const specPath = path.join(dir, specFile);
        if (!fileExists(specPath)) throw new ValidationError(`Missing plugin spec: ${specPath}`);
        const spec = (YAML.parse(fs.readFileSync(specPath, 'utf-8')) ?? {}) as Record<string, unknown>;

        // Required fields.
        if (typeof spec.name !== 'string' || !spec.name) problems.push('plugin-spec.yaml: name is required');
        else if (!/^[a-z0-9-]+$/.test(spec.name)) problems.push('plugin-spec.yaml: name must match /^[a-z0-9-]+$/');
        if (typeof spec.version !== 'string' || !spec.version) problems.push('plugin-spec.yaml: version is required');
        // Match the server/DB semver check (allows -prerelease and +build metadata).
        else if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/.test(spec.version)) problems.push('plugin-spec.yaml: version must be semver (x.y.z)');

        const pluginType = (typeof spec.pluginType === 'string' ? spec.pluginType : 'CodeBuildStep');
        if (!PLUGIN_TYPES.includes(pluginType)) problems.push(`plugin-spec.yaml: pluginType must be one of ${PLUGIN_TYPES.join(', ')}`);
        if (spec.computeType !== undefined && !COMPUTE_TYPES.includes(String(spec.computeType))) {
          problems.push(`plugin-spec.yaml: computeType must be one of ${COMPUTE_TYPES.join(', ')}`);
        }
        if (spec.failureBehavior !== undefined && !FAILURE_BEHAVIORS.includes(String(spec.failureBehavior))) {
          problems.push(`plugin-spec.yaml: failureBehavior must be one of ${FAILURE_BEHAVIORS.join(', ')}`);
        }

        const isApproval = pluginType === 'ManualApprovalStep';
        if (!isApproval && (!Array.isArray(spec.commands) || spec.commands.length === 0)) {
          problems.push('plugin-spec.yaml: commands[] is required (except for ManualApprovalStep)');
        }

        // Build-type prerequisites.
        if (buildType === 'build_image' && !isApproval && !fileExists(path.join(dir, dockerfileName))) {
          problems.push(`Dockerfile not found for buildType build_image: ${path.join(dir, dockerfileName)}`);
        }
        if (buildType === 'prebuilt' && !fileExists(path.join(dir, 'image.tar'))) {
          problems.push('image.tar not found for buildType prebuilt');
        }

        // `{{ }}` template validation — same scope roots + templatable fields the
        // server enforces at upload (pipeline-core primitives; no server dep).
        const core = await import('@pipeline-builder/pipeline-core');
        const isTpl = (f: string) =>
          f === 'description' ||
          f.startsWith('commands') ||
          f.startsWith('installCommands') ||
          f.startsWith('env.') || f.startsWith('env[') ||
          f.startsWith('buildArgs.') || f.startsWith('buildArgs[');
        const isKnown = core.allowedScopeRoots(['pipeline', 'plugin', 'env']);
        const { errors } = core.validateTemplates(spec, isTpl, isKnown);
        for (const e of errors) problems.push(`template [${e.field ?? '?'}]: ${e.message}`);

        // Plugin CONTRACT check — mirrors the server's upload validation
        // (api/plugin/src/helpers/plugin-spec.ts) so a spec rejected at upload also
        // fails here (no false-green). Two independent rules per `{{ pipeline.vars.X }}`
        // / `{{ pipeline.metadata.X }}` reference:
        //   (a) declaration: unless the token has a `| default:`, X must be declared
        //       in requiredVars / requiredMetadata;
        //   (b) coercion type: if the token has a `| number|bool|json` filter, the
        //       declared type in varsTypes/metadataTypes (default 'string') must match.
        const requiredVars = new Set(Array.isArray(spec.requiredVars) ? (spec.requiredVars as unknown[]).map(String) : []);
        const requiredMetadata = new Set(Array.isArray(spec.requiredMetadata) ? (spec.requiredMetadata as unknown[]).map(String) : []);
        const varsTypes = (spec.varsTypes as Record<string, string>) ?? {};
        const metadataTypes = (spec.metadataTypes as Record<string, string>) ?? {};
        const coerceToType: Record<string, string> = { number: 'number', bool: 'bool', json: 'json' };
        const templatableStrings: string[] = [
          ...(typeof spec.description === 'string' ? [spec.description] : []),
          ...(Array.isArray(spec.commands) ? spec.commands.filter((c): c is string => typeof c === 'string') : []),
          ...(Array.isArray(spec.installCommands) ? spec.installCommands.filter((c): c is string => typeof c === 'string') : []),
          ...Object.values((spec.env as Record<string, unknown>) ?? {}).filter((v): v is string => typeof v === 'string'),
          ...Object.values((spec.buildArgs as Record<string, unknown>) ?? {}).filter((v): v is string => typeof v === 'string'),
        ];
        for (const source of templatableStrings) {
          let tokens;
          try { tokens = core.tokenize(source); } catch { continue; }
          for (const t of tokens) {
            if (t.kind !== 'expr') continue;
            const [root, sub, key] = t.path;
            if (root !== 'pipeline' || (sub !== 'vars' && sub !== 'metadata') || !key) continue;
            const isVars = sub === 'vars';
            // (a) declaration — waived by a `| default:`.
            if (t.defaultValue === undefined) {
              const declared = isVars ? requiredVars.has(key) : requiredMetadata.has(key);
              if (!declared) problems.push(`contract: template references {{ pipeline.${sub}.${key} }} but '${key}' is not declared in ${isVars ? 'requiredVars' : 'requiredMetadata'}`);
            }
            // (b) coercion type — independent of default.
            if (t.coerce) {
              const declaredType = (isVars ? varsTypes : metadataTypes)[key] ?? 'string';
              const expectedType = coerceToType[t.coerce];
              if (expectedType && declaredType !== expectedType) {
                problems.push(`contract: {{ pipeline.${sub}.${key} | ${t.coerce} }} but declared type is '${declaredType}' (add '${key}: ${expectedType}' to ${isVars ? 'varsTypes' : 'metadataTypes'})`);
              }
            }
          }
        }

        if (problems.length === 0) {
          printSuccess(`Plugin '${String(spec.name)}' is valid`, { executionId, buildType, pluginType });
          return;
        }

        printWarning(`Found ${problems.length} problem(s):`);
        for (const p of problems) printError(`  • ${p}`);
        process.exit(1);
      } catch (err) {
        handleError(err, err instanceof ValidationError ? ERROR_CODES.VALIDATION : ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'validate-plugin', executionId },
        });
      }
    });
}
