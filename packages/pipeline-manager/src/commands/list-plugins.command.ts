import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId, formatDuration, formatFileSize, validateBoolean } from '../config/cli.constants';
import { PluginListResponse, Plugin, Config } from '../types';
import { ApiClient } from '../utils/api.client';
import { getConfig } from '../utils/config.loader';
import { ERROR_CODES, handleError } from '../utils/error.handler';
import { outputData, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output.utils';

const { bold, cyan, magenta } = pico;

/**
 * Plugin filter interface matching the CommonFilter + PluginFilter pattern
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
  namePattern?: string;
  version?: string;
  versionRange?: {
    min?: string;
    max?: string;
  };
  imageTag?: string;
}

/**
 * Validate boolean parameter
 */
/**
 * Validate number parameter
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
 * List plugins command
 *
 * Query and list plugins with comprehensive filters based on CommonFilter + PluginFilter
 *
 * @example
 * ```bash
 * # Basic usage
 * cli list-plugins
 *
 * # Filter by name
 * cli list-plugins --name auth-plugin --is-active true
 *
 * # Search with pattern
 * cli list-plugins --name-pattern "auth*" --is-active true
 *
 * # Version filtering
 * cli list-plugins --version "^1.0.0"
 * cli list-plugins --version-min "1.0.0" --version-max "2.0.0"
 *
 * # Pagination and sorting
 * cli list-plugins --limit 50 --offset 100 --sort "name:asc"
 *
 * # Output formats
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
    .option('--name-pattern <pattern>', 'Filter by name pattern (e.g., "auth*", "*-plugin")')
    .option('--version <version>', 'Filter by version (supports semver, e.g., "^1.0.0")')
    .option('--version-min <version>', 'Minimum version (inclusive)')
    .option('--version-max <version>', 'Maximum version (inclusive)')
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

        if (options.namePattern) {
          filterParams.namePattern = options.namePattern;
        }

        if (options.version) {
          // Validate semver format
          const versionPattern = /^(\^|~)?(\d+)\.(\d+)\.(\d+)(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
          if (!versionPattern.test(options.version)) {
            printWarning(`Version "${options.version}" may not be valid semver format`);
          }
          filterParams.version = options.version;
        }

        if (options.versionMin || options.versionMax) {
          filterParams.versionRange = {
            min: options.versionMin,
            max: options.versionMax,
          };

          if (options.versionMin && options.versionMax && options.versionMin > options.versionMax) {
            printError('Invalid version range', {
              min: options.versionMin,
              max: options.versionMax,
              hint: 'Minimum version must be less than or equal to maximum version',
            });
            throw new Error('Invalid version range');
          }
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
        if (filterParams.namePattern) activeFilters['Name Pattern'] = filterParams.namePattern;
        if (filterParams.version) activeFilters.Version = filterParams.version;
        if (filterParams.versionRange) activeFilters['Version Range'] = `${filterParams.versionRange.min || '*'} - ${filterParams.versionRange.max || '*'}`;
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
        let plugins: Plugin[];
        let total: number | undefined;
        let hasMore = false;

        if (response && typeof response === 'object') {
          if ('plugins' in response && Array.isArray(response.plugins)) {
            plugins = response.plugins;
            total = response.total;
            hasMore = response.hasMore || false;
          } else if ('items' in response && Array.isArray(response.items)) {
            plugins = response.items;
            total = response.total;
            hasMore = response.hasMore || false;
          } else if (Array.isArray(response)) {
            plugins = response;
          } else {
            printWarning('Unexpected response format, attempting to handle');
            plugins = [];
          }
        } else if (Array.isArray(response)) {
          plugins = response;
        } else {
          printError('Invalid response format from API');
          throw new Error('Unexpected API response format');
        }

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