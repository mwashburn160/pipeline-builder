// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import YAML from 'yaml';
import { printCommandHeader, printSslWarning, createAuthenticatedClientAsync } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printSuccess, printWarning } from '../utils/output-utils';

interface ValidateOptions {
  pipeline?: string;
  plugin?: string;
  file?: string;
  verifySsl?: boolean;
}

/**
 * Register the `validate-templates` command.
 *
 * Usage:
 *   pipeline-manager validate-templates --pipeline <uuid>
 *   pipeline-manager validate-templates --plugin <name:version>
 *   pipeline-manager validate-templates --file ./plugin-spec.yaml
 */
export function validateTemplatesCommand(program: Command): void {
  program
    .command('validate-templates')
    .description('Parse and validate {{ ... }} templates in a pipeline or plugin spec')
    .option('--pipeline <id>', 'Validate the pipeline with this ID')
    .option('--plugin <name:version>', 'Validate the plugin with this name and version')
    .option('--file <path>', 'Validate a local plugin-spec.yaml or pipeline.json file')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .action(async (options: ValidateOptions) => {
      const executionId = printCommandHeader('Validate Templates');
      try {
        printSslWarning(options.verifySsl);

        if (!options.pipeline && !options.plugin && !options.file) {
          throw new Error('One of --pipeline, --plugin, or --file is required');
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const core = require('@pipeline-builder/pipeline-core');

        const problems: Array<{ source: string; errors: { field?: string; message: string; code?: string }[] }> = [];

        if (options.file) {
          const filePath = path.resolve(options.file);
          const text = fs.readFileSync(filePath, 'utf-8');
          const doc = filePath.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);

          // Guess: if `pluginType` is present, treat as plugin spec; else pipeline
          const isPlugin = typeof (doc as { pluginType?: unknown }).pluginType === 'string';
          const errors = isPlugin
            ? validatePluginDoc(core, doc)
            : validatePipelineDoc(core, doc);
          if (errors.length) problems.push({ source: filePath, errors });
        }

        if (options.pipeline) {
          printInfo('Fetching pipeline', { id: options.pipeline });
          const client = await createAuthenticatedClientAsync(options);
          const cfg = client.getConfig();
          const res = await client.get<{ pipeline?: { props: unknown } }>(`${cfg.api.pipelineUrl}/${options.pipeline}`);
          const doc = (res as { pipeline?: { props: unknown } }).pipeline?.props
            ?? (res as { data?: { pipeline?: { props: unknown } } }).data?.pipeline?.props;
          if (!doc) throw new Error(`Pipeline ${options.pipeline} not found`);
          const errors = validatePipelineDoc(core, doc);
          if (errors.length) problems.push({ source: `pipeline/${options.pipeline}`, errors });
        }

        if (options.plugin) {
          const [name, version] = options.plugin.split(':');
          if (!name || !version) throw new Error('--plugin requires <name:version> format');
          printInfo('Fetching plugin', { name, version });
          const client = await createAuthenticatedClientAsync(options);
          const cfg = client.getConfig();
          const res = await client.get<{ plugin: unknown }>(
            `${cfg.api.pluginUrl}/find?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`,
          );
          const doc = (res as { plugin?: unknown }).plugin
            ?? (res as { data?: { plugin?: unknown } }).data?.plugin;
          if (!doc) throw new Error(`Plugin ${name}:${version} not found`);
          const errors = validatePluginDoc(core, doc);
          if (errors.length) problems.push({ source: `plugin/${name}:${version}`, errors });
        }

        if (problems.length === 0) {
          printSuccess('All templates valid', { executionId });
          return;
        }

        printWarning(`Found ${problems.reduce((a, p) => a + p.errors.length, 0)} template error(s):`);
        for (const p of problems) {
          printError(p.source);
          for (const e of p.errors) {
            console.log(`    [${e.field ?? '?'}] ${e.message}${e.code ? ` (${e.code})` : ''}`);
          }
        }
        process.exit(1);
      } catch (err) {
        handleError(err, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'validate-templates', executionId },
        });
      }
    });
}

function validatePluginDoc(core: Record<string, any>, doc: unknown): Array<{ field?: string; message: string; code?: string }> {
  const isTpl = (f: string) =>
    f === 'description' ||
    f.startsWith('commands') ||
    f.startsWith('installCommands') ||
    f.startsWith('env.') || f.startsWith('env[') ||
    f.startsWith('buildArgs.') || f.startsWith('buildArgs[');
  const isKnown = core.allowedScopeRoots(['pipeline', 'plugin', 'env']);
  const { errors } = core.validateTemplates(doc, isTpl, isKnown);
  return errors;
}

function validatePipelineDoc(core: Record<string, any>, doc: unknown): Array<{ field?: string; message: string; code?: string }> {
  const isTpl = (f: string) =>
    f === 'projectName' ||
    f.startsWith('metadata.') || f.startsWith('metadata[') ||
    f.startsWith('vars.') || f.startsWith('vars[');
  const isKnown = core.allowedScopeRoots(['metadata', 'vars']);
  const { errors } = core.validateTemplates(doc, isTpl, isKnown);
  const cycles = core.detectCycles(doc, isTpl, (f: string) => isTpl(f) ? f : null);
  return [...errors, ...cycles];
}
