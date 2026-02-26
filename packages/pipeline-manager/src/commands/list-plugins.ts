/**
 * List plugins CLI command.
 *
 * Queries the platform API for plugins with comprehensive
 * filter, pagination, and sorting options.  Results can be
 * displayed as a table, JSON, YAML, or CSV and optionally
 * exported to a file.
 *
 * @module commands/list-plugins
 */
import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId, formatDuration, formatFileSize, validateBoolean } from '../config/cli.constants';
import { PluginListResponse, Plugin, Config } from '../types';
import { ApiClient } from '../utils/api-client';
import { getConfig } from '../utils/config-loader';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { outputData, extractListResponse, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';

const { bold, cyan, magenta } = pico;

/**
 * Query parameters for the plugin list API endpoint.
 * Combines common filters (pagination, sort, access) with plugin-specific filters.
 */
interface PluginFilterParams {
  // Common filters
  id?: string | string[];
  accessModifier?: string;
  isDefault?: boolean;
  isActive?: boolean;
  limit?: number;
  offset?: number;
  sort?: string;

  // Plugin-specific filters
  name?: string;
  version?: string;
  imageTag?: string;
}

/**
 * Validates and parses a numeric CLI parameter within optional bounds.
 *
 * @param value - The raw string value from the CLI.
 * @param fieldName - Human-readable field name used in error messages.
 * @param min - Optional minimum allowed value (inclusive).
 * @param max - Optional maximum allowed value (inclusive).
 * @returns The parsed integer.
 * @throws {Error} If the value is not a number or falls outside the allowed range.
 */
function validateNumber(value: string, fieldName: string, min?: number, max?: number): number {
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new Error(`Invalid ${fieldName}: must be a number`);
  }
  if (min !== undefined && num < min) {
    throw new Error(`Invalid ${fieldName}: must be >= ${min}`);
  }
  if (max !== undefined && num > max) {
    throw new Error(`Invalid ${fieldName}: must be <= ${max}`);
  }
  return num;
}

/**
 * Registers the `list-plugins` command with the CLI program.
 *
 * Queries plugins with filters for name, version, image tag,
 * access modifier, active/default status, plus pagination and sorting.
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
    .option('--access-modifier <modifier>', 'Filter by access modifier (public/private)')
    .option('--is-default <boolean>', 'Filter by default status (true/false)')
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
      const executionId = generateExecutionId();
      const startTime = Date.now();

      try {
        printSection('List Plugins');
        console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Query Plugins'))}`);
        console.log('');

        // Build filter parameters
        const filterParams: PluginFilterParams = {};

        // Common filters
        if (options.id) {
          filterParams.id = options.id.includes(',') ? options.id.split(',').map((s: string) => s.trim()) : options.id;
        }

        if (options.accessModifier) {
          filterParams.accessModifier = options.accessModifier;
        }

        if (options.isDefault !== undefined) {
          filterParams.isDefault = validateBoolean(options.isDefault, 'is-default');
        }

        if (options.isActive !== undefined) {
          filterParams.isActive = validateBoolean(options.isActive, 'is-active');
        }

        // Pagination
        filterParams.limit = validateNumber(options.limit, 'limit', 1, 1000);
        filterParams.offset = validateNumber(options.offset, 'offset', 0);

        // Sort
        if (options.sort) {
          const sortPattern = /^[a-zA-Z_][a-zA-Z0-9_]*:(asc|desc)$/;
          if (!sortPattern.test(options.sort)) {
            printWarning(`Invalid sort format: "${options.sort}". Expected "field:asc" or "field:desc". Using default.`);
            filterParams.sort = 'createdAt:desc';
          } else {
            filterParams.sort = options.sort;
          }
        }

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
        const activeFilters: Record<string, any> = {};
        if (filterParams.id) activeFilters.ID = filterParams.id;
        if (filterParams.accessModifier) activeFilters['Access Modifier'] = filterParams.accessModifier;
        if (filterParams.isDefault !== undefined) activeFilters['Is Default'] = filterParams.isDefault;
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

        console.log('');
        printInfo('Pagination Settings');
        printKeyValue({
          Limit: filterParams.limit?.toString() || '50',
          Offset: filterParams.offset?.toString() || '0',
          Sort: filterParams.sort || 'createdAt:desc',
        });

        // Security warning for SSL verification disabled
        if (options.verifySsl === false) {
          console.log('');
          printWarning('⚠️  SSL certificate verification is DISABLED');
        }

        // Load configuration
        let config: Config = getConfig();

        // Override SSL verification if flag is provided
        if (options.verifySsl === false) {
          config = {
            ...config,
            api: {
              ...config.api,
              rejectUnauthorized: false,
            },
          };
        }

        // Create API client
        console.log('');
        printSection('API Connection');
        printInfo('Initializing API client');
        printKeyValue({
          'Base URL': config.api.baseUrl,
          'Endpoint': config.api.pluginListUrl,
          'SSL Verification': config.api.rejectUnauthorized ? 'Enabled' : 'Disabled',
        });

        const client = new ApiClient(config);

        // Validate authentication
        if (!client.isAuthenticated()) {
          printError('Authentication required', {
            hint: 'Set PLATFORM_TOKEN environment variable',
            example: 'export PLATFORM_TOKEN=your-token-here',
          });
          throw new Error('Missing authentication token');
        }

        printSuccess('API client ready');

        // Query plugins
        console.log('');
        printSection('Querying Plugins');
        printInfo('Sending request to API...');

        const requestStart = Date.now();
        const response = await client.get<PluginListResponse>(
          config.api.pluginListUrl,
          filterParams as any,
        );
        const requestDuration = Date.now() - requestStart;

        // Handle response
        const { items: plugins, total, hasMore } = extractListResponse<Plugin>(response, 'plugins');

        console.log('');
        printSection('✓ Query Complete');

        // Display results summary
        printKeyValue({
          'Plugins Found': plugins.length.toString(),
          'Total Available': total !== undefined ? total.toString() : 'Unknown',
          'Has More': hasMore ? 'Yes' : 'No',
          'Request Duration': formatDuration(requestDuration),
        });

        // Show pagination info
        if (hasMore) {
          const currentOffset = filterParams.offset || 0;
          const nextOffset = currentOffset + (filterParams.limit || 50);
          console.log('');
          printInfo('More results available', {
            hint: `Use --offset ${nextOffset} to see next page`,
          });
        }

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