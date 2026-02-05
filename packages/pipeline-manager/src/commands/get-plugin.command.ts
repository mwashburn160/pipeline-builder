import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import { Plugin, Config } from '../types';
import { ApiClient } from '../utils/api.client';
import { getConfig } from '../utils/config.loader';
import { ERROR_CODES, handleError } from '../utils/error.handler';
import { outputData, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output.utils';

const { bold, cyan, dim, green, magenta } = pico;

/**
 * Get plugin by ID command
 *
 * Retrieves detailed information about a specific plugin
 *
 * Usage:
 *   cli get-plugin --id 01936f8e-8c3a-7890-b1c2-d3e4f5a6b7c8
 *   cli get-plugin --id <plugin-id> --format json
 *   cli get-plugin --id <plugin-id> --output plugin.json
 *   cli get-plugin --id <plugin-id> --no-verify-ssl
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
      const executionId = generateExecutionId();

      try {
        printSection('Get Plugin');
        console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Execution ID'))}`);
        console.log('');

        // Display parameters
        printInfo('Request parameters', {
          id: options.id,
          format: options.format,
          output: options.output || '(console)',
          verifySsl: options.verifySsl,
        });

        // Security warning for SSL verification disabled
        if (options.verifySsl === false) {
          printWarning('SSL certificate verification is DISABLED');
          console.log('');
        }

        // Validate plugin ID
        if (!options.id || typeof options.id !== 'string' || options.id.trim().length === 0) {
          printError('Invalid plugin ID', { provided: options.id });
          throw new Error('Plugin ID must be a non-empty string');
        }

        const pluginId = options.id.trim();

        // Basic ID format validation (ULID format: 26 characters)
        if (pluginId.length !== 26 && pluginId.length !== 36) {
          printWarning('Plugin ID format may be invalid', {
            provided: pluginId,
            expectedLength: '26 characters (ULID) or 36 characters (UUID)',
            actualLength: pluginId.length,
          });
        }

        // Load configuration
        let config: Config = getConfig();

        // Override rejectUnauthorized if --no-verify-ssl flag is provided
        if (options.verifySsl === false) {
          config = {
            ...config,
            api: {
              ...config.api,
              rejectUnauthorized: false,
            },
          };
          printWarning('Overriding config: SSL verification disabled for this request');
        }

        // Create API client
        printInfo('Initializing API client', { baseUrl: config.api.baseUrl });
        const client = new ApiClient(config);

        if (!client.isAuthenticated()) {
          printError('Not authenticated', {
            hint: 'Set PLATFORM_TOKEN environment variable',
          });
          throw new Error('Authentication required');
        }

        printSuccess('API client initialized');

        // Make API request
        console.log('');
        printSection('Fetching Plugin');

        const endpoint = `${config.api.pluginUrl}/${pluginId}`;
        printInfo('Sending request', {
          endpoint: `${config.api.baseUrl}${endpoint}`,
          method: 'GET',
        });

        const startTime = Date.now();
        const response = await client.get<any>(endpoint);
        const duration = Date.now() - startTime;

        // Unwrap potential response envelopes: { data: Plugin }, { plugin: Plugin }, or bare Plugin
        const plugin: Plugin | undefined =
          response?.id !== undefined ? response :
            response?.data?.id !== undefined ? response.data :
              response?.plugin?.id !== undefined ? response.plugin :
                undefined;

        if (!plugin) {
          printError('No plugin returned from API', {
            responseKeys: response ? Object.keys(response) : '(null)',
          });
          throw new Error(`Failed to retrieve plugin with ID: ${pluginId}`);
        }

        console.log('');
        printSection('Plugin Retrieved Successfully');

        // Display plugin summary
        printKeyValue({
          'Plugin ID': green(bold(plugin.id)),
          'Name': plugin.name,
          'Version': plugin.version,
          'Organization': plugin.organization,
          'Description': plugin.description || '(not set)',
        });

        console.log('');
        printKeyValue({
          'File URL': plugin.fileUrl || '(not available)',
          'File Size': plugin.fileSize ? `${(plugin.fileSize / 1024).toFixed(2)} KB` : '(not available)',
          'Checksum': plugin.checksum ? `${plugin.checksum.substring(0, 16)}...` : '(not available)',
        });

        console.log('');
        printKeyValue({
          'Public': plugin.isPublic ? 'Yes' : 'No',
          'Active': plugin.isActive ? 'Yes' : 'No',
          'Created At': plugin.createdAt || '(not available)',
          'Updated At': plugin.updatedAt || '(not available)',
          'Uploaded By': plugin.uploadedBy || '(not available)',
        });

        // Show metadata if requested (for table format)
        if (options.showMetadata && options.format === 'table') {
          if (plugin.metadata && Object.keys(plugin.metadata).length > 0) {
            console.log('');
            printInfo('Plugin Metadata', {
              keys: Object.keys(plugin.metadata).length,
            });
            console.log('');
            console.log(dim('─'.repeat(process.stdout.columns || 80)));
            console.log(JSON.stringify(plugin.metadata, null, 2));
            console.log(dim('─'.repeat(process.stdout.columns || 80)));
          } else {
            console.log('');
            printInfo('No metadata available');
          }
        }

        // Show config if available
        if (plugin.config && Object.keys(plugin.config).length > 0 && options.format === 'table') {
          console.log('');
          printInfo('Plugin Configuration', {
            main: plugin.config.main || '(not set)',
            hasSchema: !!plugin.config.schema,
            hasDefaults: !!plugin.config.defaults,
          });
        }

        console.log('');
        printKeyValue({
          'Execution ID': executionId,
          'Duration': `${duration}ms`,
          'Status': green('✓ Success'),
        });

        // Output data in requested format
        console.log('');
        if (options.output) {
          printInfo('Saving to file', {
            path: options.output,
            format: options.format,
          });
        } else {
          printInfo('Output format', { format: options.format });
        }

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
          context: {
            command: 'get-plugin',
            executionId,
            pluginId: options.id,
            format: options.format,
            verifySsl: options.verifySsl,
          },
        });
      }
    });
}
