import { Command } from 'commander';
import { formatDuration, formatFileSize } from '../config/cli.constants';
import { PluginListResponse, Plugin } from '../types';
import { printCommandHeader, printSslWarning, createAuthenticatedClient } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { buildCommonFilters, CommonFilterParams, displayPaginationInfo, displayListResults } from '../utils/list-command-utils';
import { outputData, extractListResponse, printInfo, printKeyValue, printSection, printWarning } from '../utils/output-utils';

/**
 * Query parameters for the plugin list API endpoint.
 * Combines common filters (pagination, sort) with plugin-specific filters.
 */
interface PluginFilterParams extends CommonFilterParams {
  // Plugin-specific filters
  name?: string;
  version?: string;
  imageTag?: string;
}

/**
 * Registers the `list-plugins` command with the CLI program.
 *
 * Queries plugins with filters for name, version, image tag,
 * active status, plus pagination and sorting.
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * cli list-plugins
 * cli list-plugins --name auth-plugin --is-active true
 * cli list-plugins --version "^1.0.0"
 * cli list-plugins --limit 50 --offset 100 --sort "name:asc"
 * cli list-plugins --format json --output plugins.json
 * ```
 */
export function listPlugins(program: Command): void {
  program
    .command('list-plugins')
    .description('Query plugins with comprehensive filters')

    // Common filter options
    .option('--id <id>', 'Filter by plugin ID (can specify multiple with commas)')
    .option('--is-active <boolean>', 'Filter by active status (true/false)')
    .option('--limit <number>', 'Maximum number of results (1-1000)', parseInt, 50)
    .option('--offset <number>', 'Number of results to skip', parseInt, 0)
    .option('--sort <sort>', 'Sort format: field:direction (e.g., name:asc, createdAt:desc)')

    // Plugin-specific filter options
    .option('--name <name>', 'Filter by exact plugin name')
    .option('--version <version>', 'Filter by version (supports semver, e.g., "^1.0.0")')
    .option('--image-tag <tag>', 'Filter by Docker image tag')

    // Output options
    .option('-f, --format <format>', 'Output format (json, yaml, table, csv)', 'table')
    .option('-o, --output <file>', 'Save output to file')
    .option('--show-metadata', 'Include full metadata in output (json/yaml only)', false)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')

    .action(async (options) => {
      const executionId = printCommandHeader('List Plugins', 'Query Plugins');
      const startTime = Date.now();

      try {

        // Build filter parameters (common + plugin-specific)
        const filterParams: PluginFilterParams = {
          ...buildCommonFilters(options),
        };

        // Plugin-specific filters
        if (options.name) {
          filterParams.name = options.name;
        }

        if (options.version) {
          // Validate semver format
          const versionPattern = /^(\^|~)?(\d+)\.(\d+)\.(\d+)(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
          if (!versionPattern.test(options.version)) {
            printWarning(`Version "${options.version}" may not be valid semver format`);
          }
          filterParams.version = options.version;
        }

        if (options.imageTag) {
          filterParams.imageTag = options.imageTag;
        }

        // Display active filters
        const activeFilters: Record<string, unknown> = {};
        if (filterParams.id) activeFilters.ID = filterParams.id;
        if (filterParams.isActive !== undefined) activeFilters['Is Active'] = filterParams.isActive;
        if (filterParams.name) activeFilters.Name = filterParams.name;
        if (filterParams.version) activeFilters.Version = filterParams.version;
        if (filterParams.imageTag) activeFilters['Image Tag'] = filterParams.imageTag;

        if (Object.keys(activeFilters).length > 0) {
          printInfo('Active Filters');
          printKeyValue(activeFilters);
        } else {
          printInfo('No filters applied - fetching all plugins');
        }

        displayPaginationInfo(filterParams);

        // Security warning for SSL verification disabled
        printSslWarning(options.verifySsl);

        // Create authenticated API client
        const client = createAuthenticatedClient(options);
        const config = client.getConfig();

        // Query plugins
        console.log('');
        printSection('Querying Plugins');
        printInfo('Sending request to API...');

        const requestStart = Date.now();
        const response = await client.get<PluginListResponse>(
          config.api.pluginListUrl,
          filterParams as Record<string, unknown>,
        );
        const requestDuration = Date.now() - requestStart;

        // Handle response
        const { items: plugins, total, hasMore } = extractListResponse<Plugin>(response, 'plugins');

        console.log('');
        printSection('✓ Query Complete');

        // Display results summary
        displayListResults(plugins, total, hasMore, 'Plugins', requestDuration, filterParams);

        // Display statistics
        if (plugins.length > 0 && options.format === 'table') {
          const activeCount = plugins.filter(p => p.isActive).length;
          const publicCount = plugins.filter(p => p.isPublic === true).length;
          const totalSize = plugins.reduce((sum, p) => sum + (p.fileSize || 0), 0);

          console.log('');
          printInfo('Statistics');
          printKeyValue({
            'Active Plugins': `${activeCount}/${plugins.length}`,
            'Public Plugins': `${publicCount}/${plugins.length}`,
            'Total Size': formatFileSize(totalSize),
          });
        }

        // Output data in requested format
        console.log('');
        if (options.output) {
          printInfo('Saving to file', {
            path: options.output,
            format: options.format,
          });
        }

        // Format output data
        const outputPlugins = options.showMetadata ? plugins : plugins.map(p => ({
          'ID': p.id,
          'Name': p.name,
          'Version': p.version,
          'Organization': p.organization,
          'Active': p.isActive ? 'Yes' : 'No',
          'Public': p.isPublic ? 'Yes' : 'No',
          'Size': p.fileSize ? formatFileSize(p.fileSize) : 'N/A',
          'Created At': p.createdAt || 'N/A',
        }));

        outputData(outputPlugins, {
          format: options.format,
          file: options.output,
        });

        // Performance metrics
        console.log('');
        printKeyValue({
          'Execution ID': executionId,
          'Total Duration': formatDuration(Date.now() - startTime),
        });

        console.log('');

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'list-plugins',
            executionId,
            filters: options,
            verifySsl: options.verifySsl,
          },
        });
      }
    });
}
