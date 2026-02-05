import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import { Pipeline, Config } from '../types';
import { ApiClient } from '../utils/api.client';
import { getConfig } from '../utils/config.loader';
import { ERROR_CODES, handleError } from '../utils/error.handler';
import { outputData, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output.utils';

const { bold, cyan, dim, green, magenta } = pico;

/**
 * Get pipeline by ID command
 *
 * Retrieves detailed information about a specific pipeline
 *
 * Usage:
 *   cli get-pipeline --id <pipeline-id>
 *   cli get-pipeline --id <pipeline-id> --format json
 *   cli get-pipeline --id <pipeline-id> --output pipeline.json
 *   cli get-pipeline --id <pipeline-id> --no-verify-ssl
 */
export function getPipeline(program: Command): void {
  program
    .command('get-pipeline')
    .description('Get a single pipeline by ID')
    .requiredOption('-i, --id <id>', 'Pipeline ID')
    .option('-f, --format <format>', 'Output format (json, yaml, table)', 'json')
    .option('-o, --output <file>', 'Save output to file')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--show-props', 'Show full pipeline properties in table format', false)
    .action(async (options) => {
      const executionId = generateExecutionId();

      try {
        printSection('Get Pipeline');
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

        // Validate pipeline ID
        if (!options.id || typeof options.id !== 'string' || options.id.trim().length === 0) {
          printError('Invalid pipeline ID', { provided: options.id });
          throw new Error('Pipeline ID must be a non-empty string');
        }

        const pipelineId = options.id.trim();

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
        printSection('Fetching Pipeline');

        const endpoint = `${config.api.pipelineUrl}/${pipelineId}`;
        printInfo('Sending request', {
          endpoint: `${config.api.baseUrl}${endpoint}`,
          method: 'GET',
        });

        const startTime = Date.now();
        const response = await client.get<any>(endpoint);
        const duration = Date.now() - startTime;

        // Unwrap potential response envelopes: { data: Pipeline }, { pipeline: Pipeline }, or bare Pipeline
        const pipeline: Pipeline | undefined =
          response?.id !== undefined ? response :
            response?.data?.id !== undefined ? response.data :
              response?.pipeline?.id !== undefined ? response.pipeline :
                undefined;

        if (!pipeline) {
          printError('No pipeline returned from API', {
            responseKeys: response ? Object.keys(response) : '(null)',
          });
          throw new Error(`Failed to retrieve pipeline with ID: ${pipelineId}`);
        }

        console.log('');
        printSection('Pipeline Retrieved Successfully');

        // Display pipeline summary
        printKeyValue({
          'Pipeline ID': green(bold(pipeline.id)),
          'Project': pipeline.project,
          'Organization': pipeline.organization,
          'Name': pipeline.pipelineName || '(not set)',
          'Access': pipeline.accessModifier || 'private',
          'Default': pipeline.isDefault ? 'Yes' : 'No',
          'Active': pipeline.isActive ? 'Yes' : 'No',
          'Created At': pipeline.createdAt || '(not available)',
          'Updated At': pipeline.updatedAt || '(not available)',
        });

        // Show properties if requested (for table format)
        if (options.showProps && options.format === 'table') {
          console.log('');
          printInfo('Pipeline Properties', {
            keys: Object.keys(pipeline.props || {}).length,
          });

          if (pipeline.props && Object.keys(pipeline.props).length > 0) {
            console.log('');
            console.log(dim('─'.repeat(process.stdout.columns || 80)));
            console.log(JSON.stringify(pipeline.props, null, 2));
            console.log(dim('─'.repeat(process.stdout.columns || 80)));
          }
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

        outputData(pipeline, {
          format: options.format,
          file: options.output,
          silent: false,
        });

        if (options.output) {
          console.log('');
          printSuccess('Pipeline data saved', { path: options.output });
        }

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'get-pipeline',
            executionId,
            pipelineId: options.id,
            format: options.format,
            verifySsl: options.verifySsl,
          },
        });
      }
    });
}
