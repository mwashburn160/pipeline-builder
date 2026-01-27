import { Command } from 'commander';
import { ApiClient } from '../utils/api-client';
import { getConfig } from '../utils/config-loader';
import { assert, ERROR_CODES, handleError } from '../utils/error-handler';
import { outputData, printInfo, printSuccess } from '../utils/output-utils';

/**
 * Get plugin by ID command
 *
 * Usage:
 *   cli get-plugin --id 01936f8e-8c3a-7890-b1c2-d3e4f5a6b7c8
 */
export function get_plugin(program: Command): void {
  program
    .command('get-plugin')
    .description('Get a single plugin by ID')
    .requiredOption('-i, --id <id>', 'Plugin ID')
    .option('-f, --format <format>', 'Output format (json, yaml, table)', 'json')
    .option('-o, --output <file>', 'Save output to file')
    .action(async (options) => {
      try {
        printInfo('Fetching plugin', {
          id: options.id,
        });

        // Load configuration
        const config = getConfig();

        // Validate plugin ID
        assert(options.id, 'Plugin ID is required', 'id');

        // Make API request
        printInfo('Sending request to API', {
          endpoint: `${config.api.baseUrl}${config.api.pluginUrl}/${options.id}`,
        });

        const client = new ApiClient(config);
        const plugin = await client.get(
          `${config.api.pluginUrl}/${options.id}`,
        );

        printSuccess('Plugin retrieved successfully', {
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
        });

        // Output data in requested format
        outputData(plugin, {
          format: options.format,
          file: options.output,
          silent: false,
        });

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'get-plugin',
            id: options.id,
          },
        });
      }
    });
}