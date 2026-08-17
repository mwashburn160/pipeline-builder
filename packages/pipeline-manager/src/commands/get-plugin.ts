// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import pico from 'picocolors';
import { runGetEntity } from './entity-get.js';
import { formatFileSize } from '../config/cli.constants.js';
import { type Plugin } from '../types/index.js';

const { bold, green } = pico;

/**
 * Registers the `get-plugin` command with the CLI program.
 *
 * @example
 * ```bash
 * pipeline-manager plugin get --id <plugin-id>
 * pipeline-manager plugin get --id <plugin-id> --format json
 * pipeline-manager plugin get --id <plugin-id> --output plugin.json
 * ```
 */
export function getPlugin(program: Command): void {
  program
    .command('get')
    .description('Get a single plugin by ID')
    .requiredOption('-i, --id <id>', 'Plugin ID')
    .option('-f, --format <format>', 'Output format (json, yaml, table)', 'json')
    .option('-o, --output <file>', 'Save output to file')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--show-metadata', 'Show full plugin metadata in table format', false)
    .action((options) => runGetEntity<Plugin>(program, options, {
      label: 'Plugin',
      responseKey: 'plugin',
      urlFor: (client, id) => `${client.getConfig().api.pluginUrl}/${id}`,
      summary: (plugin) => ({
        'Plugin ID': green(bold(plugin.id)),
        'Name': plugin.name,
        'Version': plugin.version,
        'Organization': plugin.organization,
        'Description': plugin.description || '(not set)',
        'File Size': plugin.fileSize ? formatFileSize(plugin.fileSize) : '(not available)',
        'Public': plugin.isPublic ? 'Yes' : 'No',
        'Active': plugin.isActive ? 'Yes' : 'No',
        'Created At': plugin.createdAt || '(not available)',
        'Updated At': plugin.updatedAt || '(not available)',
      }),
      extra: (options, plugin) =>
        options.showMetadata && options.format === 'table' && plugin.metadata && Object.keys(plugin.metadata).length > 0
          ? { infoLabel: 'Plugin Metadata', payload: plugin.metadata }
          : null,
      commandName: 'get-plugin',
      idContextKey: 'pluginId',
    }));
}
