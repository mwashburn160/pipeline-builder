// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import { checkPluginTemplates, type PluginTemplateEngine } from '@pipeline-builder/api-core';
import { Command } from 'commander';
import YAML from 'yaml';
import { printCommandHeader, printSslWarning, createAuthenticatedClientAsync, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printError, printInfo, printSuccess, printWarning } from '../utils/output-utils.js';
import { extractSingleResponse } from '../utils/response-utils.js';

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
 *   pipeline-manager template validate --pipeline <uuid>
 *   pipeline-manager template validate --plugin <name:version>
 *   pipeline-manager template validate --file ./plugin-spec.yaml
 */
export function validateTemplatesCommand(program: Command): void {
  withSslOptions(program
    .command('validate')
    .description('Parse and validate {{ ... }} templates in a pipeline or plugin spec')
    .option('--pipeline <id>', 'Validate the pipeline with this ID')
    .option('--plugin <name:version>', 'Validate the plugin with this name and version')
    .option('--file <path>', 'Validate a local plugin-spec.yaml or pipeline.json file'))
    .action(async (options: ValidateOptions) => {
      const executionId = printCommandHeader('Validate Templates');
      try {
        printSslWarning(options.verifySsl);

        if (!options.pipeline && !options.plugin && !options.file) {
          throw new Error('One of --pipeline, --plugin, or --file is required');
        }

        const core = await import('@pipeline-builder/pipeline-core');

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
          const doc = extractSingleResponse<{ props: unknown }>(res, 'pipeline', 'props')?.props;
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
          const doc = extractSingleResponse<Record<string, unknown>>(res, 'plugin', 'name');
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

/** The plugin template contract the upload applies (api-core's shared check). */
function validatePluginDoc(core: PluginTemplateEngine, doc: unknown): Array<{ field?: string; message: string; code?: string }> {
  return checkPluginTemplates(doc as object, core).map((issue) => ({
    field: issue.line !== undefined ? `${issue.field}:${issue.line}:${issue.col}` : issue.field,
    message: issue.message,
    code: issue.kind,
  }));
}

/**
 * The pipeline props contract the API's create/update applies (pipeline-core's
 * `validatePipelineProps`): `project`, `vars`, the metadata layers `global` /
 * `defaults.metadata` / `synth.metadata`, and no template in a `synth.source`
 * identity field. `doc` is BuilderProps (a `--file` pipeline properties JSON,
 * or a fetched pipeline's `props`).
 */
function validatePipelineDoc(core: typeof import('@pipeline-builder/pipeline-core'), doc: unknown): Array<{ field?: string; message: string; code?: string }> {
  const props = doc && typeof doc === 'object' ? doc : {};
  return core.validatePipelineProps(props).map((e) => ({
    field: e.line !== undefined ? `${e.field}:${e.line}:${e.col}` : e.field,
    message: e.message,
    code: e.code,
  }));
}
