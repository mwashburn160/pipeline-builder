import { Command } from 'commander';
import pico from 'picocolors';
import { Pipeline, PipelineResponse } from '../types';
import { createAuthenticatedClient, printCommandHeader, printExecutionSummary, printSslWarning, validateEntityId } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { extractSingleResponse, outputData, printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const { bold, dim, green } = pico;

/**
 * Registers the `get-pipeline` command with the CLI program.
 *
 * @example
 * ```bash
 * pipeline-manager get-pipeline --id <pipeline-id>
 * pipeline-manager get-pipeline --id <pipeline-id> --format json
 * pipeline-manager get-pipeline --id <pipeline-id> --output pipeline.json
 * ```
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
      const executionId = printCommandHeader('Get Pipeline');

      try {
        printSslWarning(options.verifySsl);
        printInfo('Request parameters', {
          id: options.id,
          format: options.format,
          output: options.output || '(console)',
        });

        const pipelineId = validateEntityId(options.id, 'Pipeline');
        const client = createAuthenticatedClient(options);

        // Fetch pipeline
        console.log('');
        printSection('Fetching Pipeline');

        const startTime = Date.now();
        const response = await client.get<PipelineResponse>(
          `${client.getConfig().api.pipelineUrl}/${pipelineId}`,
        );
        const duration = Date.now() - startTime;

        const pipeline = extractSingleResponse<Pipeline>(response, 'pipeline', 'id');
        if (!pipeline) {
          printError('No pipeline returned from API');
          throw new Error(`Failed to retrieve pipeline with ID: ${pipelineId}`);
        }

        console.log('');
        printSection('Pipeline Retrieved Successfully');

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

        // Show properties if requested
        if (options.showProps && options.format === 'table' && pipeline.props && Object.keys(pipeline.props).length > 0) {
          console.log('');
          printInfo('Pipeline Properties', { keys: Object.keys(pipeline.props).length });
          console.log(dim('─'.repeat(process.stdout.columns || 80)));
          console.log(JSON.stringify(pipeline.props, null, 2));
          console.log(dim('─'.repeat(process.stdout.columns || 80)));
        }

        printExecutionSummary(executionId, duration);

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
          context: { command: 'get-pipeline', executionId, pipelineId: options.id },
        });
      }
    });
}
