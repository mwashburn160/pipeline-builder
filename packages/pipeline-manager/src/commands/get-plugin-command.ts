import { Command } from 'commander';
import { ApiClient } from '../utils/api-client';
import { getConfig } from '../utils/config-loader';
import { assert, ERROR_CODES, handleError } from '../utils/error-handler';
import { outputData, printInfo, printSuccess } from '../utils/output-utils';

/**
 * Get plugin by name command
 *
 * Usage:
 *   cli get-plugin --name nodejs-build
 *   cli get-plugin --name nodejs-build --version 1.0.0
 */
export function get_plugin(program: Command): void {
  program
    .command('get-plugin')
    .description('Get a single plugin by name')
    .requiredOption('-n, --name <n>', 'Plugin name')
    .option('--version <version>', 'Plugin version (optional)')
    .option('-f, --format <format>', 'Output format (json, yaml, table)', 'json')
    .option('-o, --output <file>', 'Save output to file')
    .action(async (options) => {
      try {
        printInfo('Fetching plugin', {
          name: options.name,
          version: options.version || 'latest',
        });

        // Load configuration
        const config = getConfig();

        // Validate plugin name
        assert(options.name, 'Plugin name is required', 'name');

        // Build query parameters
        const params: Record<string, string> = {
          name: options.name,
        };
        if (options.version) {
          params.version = options.version;
        }

        // Make API request
        printInfo('Sending request to API', {
          endpoint: `${config.api.baseUrl}${config.api.pluginUrl}`,
        });

        const client = new ApiClient(config);
        const plugin = await client.get(
          config.api.pluginUrl,
          params,
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
            name: options.name,
            version: options.version,
          },
        });
      }
    });
}