// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import pico from 'picocolors';
import { runGetEntity } from './entity-get.js';
import { withSslOptions } from '../utils/command-utils.js';
import { type Pipeline } from '../types/index.js';

const { bold, green } = pico;

/**
 * Registers the `get-pipeline` command with the CLI program.
 *
 * @example
 * ```bash
 * pipeline-manager pipeline get --id <pipeline-id>
 * pipeline-manager pipeline get --id <pipeline-id> --format json
 * pipeline-manager pipeline get --id <pipeline-id> --output pipeline.json
 * ```
 */
export function getPipeline(program: Command): void {
  withSslOptions(
    program
      .command('get')
      .description('Get a single pipeline by ID')
      .requiredOption('-i, --id <id>', 'Pipeline ID')
      .option('-f, --format <format>', 'Output format (json, yaml, table)', 'json')
      .option('-o, --output <file>', 'Save output to file'),
  )
    .option('--show-props', 'Show full pipeline properties in table format', false)
    .action((options) => runGetEntity<Pipeline>(program, options, {
      label: 'Pipeline',
      responseKey: 'pipeline',
      urlFor: (client, id) => `${client.getConfig().api.pipelineUrl}/${id}`,
      summary: (pipeline) => ({
        'Pipeline ID': green(bold(pipeline.id)),
        'Project': pipeline.project,
        'Organization': pipeline.organization,
        'Name': pipeline.pipelineName || '(not set)',
        'Access': pipeline.accessModifier || 'private',
        'Default': pipeline.isDefault ? 'Yes' : 'No',
        'Active': pipeline.isActive ? 'Yes' : 'No',
        'Created At': pipeline.createdAt || '(not available)',
        'Updated At': pipeline.updatedAt || '(not available)',
      }),
      extra: (options, pipeline) =>
        options.showProps && options.format === 'table' && pipeline.props && Object.keys(pipeline.props).length > 0
          ? { infoLabel: 'Pipeline Properties', payload: pipeline.props }
          : null,
      commandName: 'get-pipeline',
      idContextKey: 'pipelineId',
    }));
}
