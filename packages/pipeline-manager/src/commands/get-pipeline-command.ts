import { Command } from 'commander';
import { ApiClient } from '../utils/api-client';
import { getConfig } from '../utils/config-loader';
import { assert, ERROR_CODES, handleError } from '../utils/error-handler';
import { outputData, printInfo, printSuccess } from '../utils/output-utils';

/**
 * Get pipeline by ID command
 *
 * Usage:
 *   cli get-pipeline --id <pipeline-id>
 *   cli get-pipeline --id <pipeline-id> --format json
 */
export function get_pipeline(program: Command): void {
  program
    .command('get-pipeline')
    .description('Get a single pipeline by ID')
    .requiredOption('-i, --id <id>', 'Pipeline ID')
    .option('-f, --format <format>', 'Output format (json, yaml, table)', 'json')
    .option('-o, --output <file>', 'Save output to file')
    .action(async (options) => {
      try {
        printInfo('Fetching pipeline', { id: options.id });

        // Load configuration
        const config = getConfig();

        // Validate pipeline ID
        assert(options.id, 'Pipeline ID is required', 'id');

        // Make API request
        printInfo('Sending request to API', {
          endpoint: `${config.api.baseUrl}${config.api.pipelineUrl}/${options.id}`,
        });

        const client = new ApiClient(config);
        const pipeline = await client.get(
          `${config.api.pipelineUrl}/${options.id}`,
        );

        printSuccess('Pipeline retrieved successfully', {
          id: pipeline.id,
          project: pipeline.project,
          organization: pipeline.organization,
        });

        // Output data in requested format
        outputData(pipeline, {
          format: options.format,
          file: options.output,
          silent: false,
        });

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'get-pipeline',
            pipelineId: options.id,
          },
        });
      }
    });
}