import * as fs from 'fs';
import { Command } from 'commander';
import { ApiClient } from '../utils/api-client';
import { getConfig } from '../utils/config-loader';
import { assert, ERROR_CODES, handleError } from '../utils/error-handler';
import { fileExists, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

interface PipelineConfig {
  project: string;
  organization: string;
  accessModifier?: 'public' | 'private';
  props: Record<string, unknown>;
}

/**
 * Create pipeline command
 *
 * Usage:
 *   cli create-pipeline --project my-app --organization acme --file pipeline.json
 *   cli create-pipeline --project my-app --organization acme --file pipeline.json --public
 */
export function create_pipeline(program: Command): void {
  program
    .command('create-pipeline')
    .description('Create a new pipeline configuration')
    .requiredOption('-p, --project <project>', 'Project name')
    .requiredOption('-o, --organization <organization>', 'Organization name')
    .requiredOption('-f, --file <file>', 'Path to pipeline configuration JSON file')
    .option('--public', 'Make pipeline publicly accessible (default: private)', false)
    .action(async (options) => {
      try {
        printSection('Create Pipeline');

        printInfo('Configuration', {
          project: options.project,
          organization: options.organization,
          file: options.file,
          accessModifier: options.public ? 'public' : 'private',
        });

        // Load configuration
        const config = getConfig();

        // Validate file exists
        assert(fileExists(options.file), `Pipeline configuration file not found: ${options.file}`, 'file');

        // Read and parse pipeline configuration
        printInfo('Reading pipeline configuration', { file: options.file });
        const fileContent = fs.readFileSync(options.file, 'utf-8');
        let props: Record<string, unknown>;

        try {
          props = JSON.parse(fileContent);
        } catch (parseError) {
          throw new Error(
            `Failed to parse pipeline configuration file: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          );
        }

        // Validate props is an object
        assert(props && typeof props === 'object', 'Pipeline configuration must be a valid JSON object', 'props');

        printSuccess('Pipeline configuration loaded successfully');

        // Build request body
        const requestBody: PipelineConfig = {
          project: options.project,
          organization: options.organization,
          accessModifier: options.public ? 'public' : 'private',
          props,
        };

        // Make API request
        printInfo('Sending request to API', {
          endpoint: `${config.api.baseUrl}${config.api.pipelinePostUrl}`,
          project: requestBody.project,
          organization: requestBody.organization,
        });

        const client = new ApiClient(config);
        const response = await client.post(
          config.api.pipelinePostUrl,
          requestBody,
        );

        printSection('Pipeline Created');
        printKeyValue({
          'ID': response.id,
          'Project': response.project,
          'Organization': response.organization,
          'Pipeline Name': response.pipelineName || '(not set)',
          'Access Modifier': response.accessModifier,
          'Is Default': response.isDefault,
          'Is Active': response.isActive,
          'Created At': response.createdAt,
        });

        // Print SSE logs URL if available
        if (response['X-Request-Id']) {
          printInfo('View deployment logs', {
            url: `${config.api.baseUrl}/logs/${response['X-Request-Id']}`,
          });
        }

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'create-pipeline',
            project: options.project,
            organization: options.organization,
            file: options.file,
          },
        });
      }
    });
}