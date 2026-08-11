// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import YAML from 'yaml';
import { printCommandHeader } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printInfo, printSection, printSuccess, fileExists, ensureOutputDirectory } from '../utils/output-utils.js';

interface NewPluginOptions {
  name?: string;
  category?: string;
  type?: string;
  compute?: string;
  buildType?: string;
  dir?: string;
  force?: boolean;
}

const PLUGIN_TYPES = ['CodeBuildStep', 'ShellStep', 'ManualApprovalStep'];
const COMPUTE_TYPES = ['SMALL', 'MEDIUM', 'LARGE', 'X2_LARGE'];
const BUILD_TYPES = ['build_image', 'prebuilt', 'metadata_only'];

/**
 * Register the `new-plugin` command — scaffold a local plugin directory
 * (`config.yaml`, `plugin-spec.yaml`, and a starter `Dockerfile`) that
 * `validate-plugin` accepts and `upload-plugin` can package.
 *
 * Usage:
 *   pipeline-manager plugin new --name my-linter --category quality
 *   pipeline-manager plugin new --name approve --type ManualApprovalStep
 */
export function newPlugin(program: Command): void {
  program
    .command('new')
    .description('Scaffold a local plugin directory (config.yaml, plugin-spec.yaml, Dockerfile)')
    .requiredOption('--name <name>', 'Plugin name (lowercase letters, digits, hyphens)')
    .option('--category <category>', 'Plugin category (e.g. quality, security, language)', 'general')
    .option('--type <type>', `Plugin type: ${PLUGIN_TYPES.join(' | ')}`, 'CodeBuildStep')
    .option('--compute <compute>', `Compute type: ${COMPUTE_TYPES.join(' | ')}`, 'SMALL')
    .option('--build-type <buildType>', `Build type: ${BUILD_TYPES.join(' | ')}`, 'build_image')
    .option('--dir <path>', 'Target directory (default ./<name>)')
    .option('--force', 'Overwrite an existing directory', false)
    .action((options: NewPluginOptions) => {
      const executionId = printCommandHeader('New Plugin');
      try {
        const name = options.name ?? '';
        // Canonical plugin-name pattern (matches validate-plugin, upload-plugin,
        // and the server's NAME_PATTERN).
        if (!/^[a-z0-9-]+$/.test(name)) {
          throw new ValidationError('Plugin name must contain only lowercase letters, digits, and hyphens (/^[a-z0-9-]+$/)');
        }
        const pluginType = options.type ?? 'CodeBuildStep';
        if (!PLUGIN_TYPES.includes(pluginType)) throw new ValidationError(`--type must be one of: ${PLUGIN_TYPES.join(', ')}`);
        const computeType = options.compute ?? 'SMALL';
        if (!COMPUTE_TYPES.includes(computeType)) throw new ValidationError(`--compute must be one of: ${COMPUTE_TYPES.join(', ')}`);
        const buildType = options.buildType ?? 'build_image';
        if (!BUILD_TYPES.includes(buildType)) throw new ValidationError(`--build-type must be one of: ${BUILD_TYPES.join(', ')}`);

        const targetDir = path.resolve(options.dir ?? `./${name}`);
        if (fileExists(targetDir) && !options.force) {
          throw new ValidationError(`Directory already exists: ${targetDir} (use --force to overwrite)`);
        }
        ensureOutputDirectory(targetDir);

        const isApproval = pluginType === 'ManualApprovalStep';
        // Dockerfile only for image builds of a real build step.
        const needsDockerfile = buildType === 'build_image' && !isApproval;

        // config.yaml — build manifest.
        const config: Record<string, unknown> = { pluginSpec: 'plugin-spec.yaml', buildType };
        if (needsDockerfile) config.dockerfile = 'Dockerfile';
        fs.writeFileSync(path.join(targetDir, 'config.yaml'), YAML.stringify(config), 'utf-8');

        // plugin-spec.yaml — the PluginSpec.
        const spec: Record<string, unknown> = {
          name,
          version: '1.0.0',
          description: `${name} plugin`,
          keywords: [] as string[],
          category: options.category ?? 'general',
          pluginType,
          computeType,
          timeout: isApproval ? 0 : 10,
          failureBehavior: 'fail',
          secrets: [] as unknown[],
        };
        if (!isApproval) {
          spec.installCommands = ['echo "install step — add your setup commands"'];
          spec.commands = [`echo "run step for ${name} — replace with real commands"`];
          if (needsDockerfile) spec.dockerfile = 'Dockerfile';
        }
        fs.writeFileSync(path.join(targetDir, 'plugin-spec.yaml'), YAML.stringify(spec), 'utf-8');

        // Starter Dockerfile.
        if (needsDockerfile) {
          const dockerfile = [
            `# Dockerfile for the ${name} plugin.`,
            '# The base image provides the toolchain your commands need — keep it minimal and pinned.',
            'FROM alpine:3.20',
            '',
            '# TODO: install the tools your plugin-spec commands invoke, e.g.:',
            '# RUN apk add --no-cache python3',
            '',
            'WORKDIR /workspace',
            '',
          ].join('\n');
          fs.writeFileSync(path.join(targetDir, 'Dockerfile'), dockerfile, 'utf-8');
        }

        // README.
        const relDir = options.dir ?? `./${name}`;
        fs.writeFileSync(path.join(targetDir, 'README.md'), [
          `# ${name}`,
          '',
          `${name} plugin.`,
          '',
          'Validate before upload:',
          '',
          `    pipeline-manager plugin validate --dir ${relDir}`,
          '',
          'Package and upload:',
          '',
          `    (cd ${relDir} && zip -r ../${name}.zip .)`,
          `    pipeline-manager plugin upload --file ${name}.zip --organization <org>`,
          '',
        ].join('\n'), 'utf-8');

        printSection('Scaffolded plugin', targetDir);
        printInfo('Created files', { files: ['config.yaml', 'plugin-spec.yaml', ...(needsDockerfile ? ['Dockerfile'] : []), 'README.md'] });
        printSuccess('Plugin scaffold created — edit plugin-spec.yaml then run validate-plugin', { executionId, dir: targetDir });
      } catch (err) {
        handleError(err, err instanceof ValidationError ? ERROR_CODES.VALIDATION : ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'new-plugin', executionId },
        });
      }
    });
}
