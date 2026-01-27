import { Command } from 'commander';
import { ApiClient } from '../utils/api-client';
import { getConfig } from '../utils/config-loader';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { outputData, printInfo, printSuccess } from '../utils/output-utils';

/**
 * List plugins command
 *
 * Usage:
 *   cli list-plugins
 *   cli list-plugins --name nodejs --is-active true
 *   cli list-plugins --access-modifier public --limit 20
 */
export function list_plugins(program: Command): void {
  program
    .command('list-plugins')
    .description('Query plugins with filters')
    .option('--name <n>', 'Filter by plugin name')
    .option('--version <version>', 'Filter by version')
    .option('--is-default <boolean>', 'Filter by default flag (true/false)')
    .option('--is-active <boolean>', 'Filter by active status (true/false)')
    .option('--access-modifier <modifier>', 'Filter by access modifier (public/private)')
    .option('--limit <number>', 'Number of results to return', '50')
    .option('--offset <number>', 'Pagination offset', '0')
    .option('-f, --format <format>', 'Output format (json, yaml, table)', 'table')
    .option('-o, --output <file>', 'Save output to file')
    .action(async (options) => {
      try {
        printInfo('Querying plugins', {
          filters: Object.keys(options).filter(k =>
            options[k] && !['format', 'output'].includes(k),
          ),
        });

        // Load configuration
        const config = getConfig();

        // Build query parameters
        const params: Record<string, string> = {};
        if (options.name) params.name = options.name;
        if (options.version) params.version = options.version;
        if (options.isDefault) params.isDefault = options.isDefault;
        if (options.isActive) params.isActive = options.isActive;
        if (options.accessModifier) params.accessModifier = options.accessModifier;
        if (options.limit) params.limit = options.limit;
        if (options.offset) params.offset = options.offset;

        // Make API request
        printInfo('Sending request to API', {
          endpoint: `${config.api.baseUrl}${config.api.pluginListUrl}`,
          params: Object.keys(params).length,
        });

        const client = new ApiClient(config);
        const response = await client.get(
          config.api.pluginListUrl,
          params,
        );

        const plugins = response.data || response;
        const count = response.count || (Array.isArray(plugins) ? plugins.length : 0);

        printSuccess('Plugins retrieved successfully', {
          count,
          limit: options.limit,
          offset: options.offset,
        });

        // Output data in requested format
        outputData(plugins, {
          format: options.format,
          file: options.output,
          silent: false,
        });

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'list-plugins',
            filters: {
              name: options.name,
              version: options.version,
              accessModifier: options.accessModifier,
            },
          },
        });
      }
    });
}