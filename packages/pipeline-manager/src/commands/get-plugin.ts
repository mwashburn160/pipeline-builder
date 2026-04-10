// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import pico from 'picocolors';
import { Plugin, PluginResponse } from '../types';
import { createAuthenticatedClient, printCommandHeader, printExecutionSummary, printSslWarning, validateEntityId } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { extractSingleResponse, outputData, printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const { bold, dim, green } = pico;

/**
 * Registers the `get-plugin` command with the CLI program.
 *
 * @example
 * ```bash
 * pipeline-manager get-plugin --id <plugin-id>
 * pipeline-manager get-plugin --id <plugin-id> --format json
 * pipeline-manager get-plugin --id <plugin-id> --output plugin.json
 * ```
 */
export function getPlugin(program: Command): void {
  program
    .command('get-plugin')
    .description('Get a single plugin by ID')
    .requiredOption('-i, --id <id>', 'Plugin ID')
    .option('-f, --format <format>', 'Output format (json, yaml, table)', 'json')
    .option('-o, --output <file>', 'Save output to file')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--show-metadata', 'Show full plugin metadata in table format', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Get Plugin');

      try {
        printSslWarning(options.verifySsl);
        printInfo('Request parameters', {
          id: options.id,
          format: options.format,
          output: options.output || '(console)',
        });

        const pluginId = validateEntityId(options.id, 'Plugin');
        const client = createAuthenticatedClient(options);

        // Fetch plugin
        console.log('');
        printSection('Fetching Plugin');

        const startTime = Date.now();
        const response = await client.get<PluginResponse>(
          `${client.getConfig().api.pluginUrl}/${pluginId}`,
        );
        const duration = Date.now() - startTime;

        const plugin = extractSingleResponse<Plugin>(response, 'plugin', 'id');
        if (!plugin) {
          printError('No plugin returned from API');
          throw new Error(`Failed to retrieve plugin with ID: ${pluginId}`);
        }

        console.log('');
        printSection('Plugin Retrieved Successfully');

        printKeyValue({
          'Plugin ID': green(bold(plugin.id)),
          'Name': plugin.name,
          'Version': plugin.version,
          'Organization': plugin.organization,
          'Description': plugin.description || '(not set)',
          'File Size': plugin.fileSize ? `${(plugin.fileSize / 1024).toFixed(2)} KB` : '(not available)',
          'Public': plugin.isPublic ? 'Yes' : 'No',
          'Active': plugin.isActive ? 'Yes' : 'No',
          'Created At': plugin.createdAt || '(not available)',
          'Updated At': plugin.updatedAt || '(not available)',
        });

        // Show metadata if requested
        if (options.showMetadata && options.format === 'table' && plugin.metadata && Object.keys(plugin.metadata).length > 0) {
          console.log('');
          printInfo('Plugin Metadata', { keys: Object.keys(plugin.metadata).length });
          console.log(dim('─'.repeat(process.stdout.columns || 80)));
          console.log(JSON.stringify(plugin.metadata, null, 2));
          console.log(dim('─'.repeat(process.stdout.columns || 80)));
        }

        printExecutionSummary(executionId, duration);

        outputData(plugin, {
          format: options.format,
          file: options.output,
          silent: false,
        });

        if (options.output) {
          console.log('');
          printSuccess('Plugin data saved', { path: options.output });
        }

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'get-plugin', executionId, pluginId: options.id },
        });
      }
    });
}
