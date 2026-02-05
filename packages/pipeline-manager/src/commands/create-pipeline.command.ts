import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId, formatDuration, formatFileSize, FILE_SIZE_LIMITS } from '../config/cli.constants';
import { Pipeline, CreatePipelineRequest, Config } from '../types';
import { ApiClient } from '../utils/api.client';
import { getConfig } from '../utils/config.loader';
import { ERROR_CODES, handleError } from '../utils/error.handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output.utils';

const { bold, cyan, dim, green, magenta } = pico;

/**
 * Create pipeline command
 * Create a new pipeline with the provided configuration
 */
export function createPipeline(program: Command): void {
  program
    .command('create-pipeline')
    .description('Create a new pipeline with the provided configuration')
    .requiredOption('-f, --file <file>', 'Path to pipeline properties JSON file')
    .option('-p, --project <project>', 'Project name (falls back to value in props file)')
    .option('-o, --organization <organization>', 'Organization name (falls back to value in props file)')
    .option('-n, --name <name>', 'Pipeline name')
    .option('-a, --access <modifier>', 'Access modifier (public|private)', 'private')
    .option('--default', 'Set as default pipeline', false)
    .option('--active', 'Set pipeline as active', true)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--dry-run', 'Validate inputs without creating pipeline', false)
    .action(async (options) => {
      const executionId = generateExecutionId();
      const startTime = Date.now();

      try {
        printSection('Pipeline Creation');
        console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Creating Pipeline'))}`);
        console.log('');

        // Display parameters
        printInfo('Configuration');
        printKeyValue({
          'Project': options.project || '(from props file)',
          'Organization': options.organization || '(from props file)',
          'Name': options.name || '(not set)',
          'Access Modifier': options.access,
          'Default Pipeline': options.default ? 'Yes' : 'No',
          'Active': options.active ? 'Yes' : 'No',
          'Properties File': options.file,
          'SSL Verification': options.verifySsl === false ? 'Disabled' : 'Enabled',
          'Dry Run': options.dryRun ? 'Yes' : 'No',
        });

        // Security warning for SSL verification disabled
        if (options.verifySsl === false) {
          console.log('');
          printWarning('⚠️  SSL certificate verification is DISABLED');
        }

        console.log('');
        printSection('File Validation');

        // Validate file exists
        if (!fs.existsSync(options.file)) {
          printError('Properties file not found', { path: options.file });
          throw new Error(`File not found: ${options.file}`);
        }

        // Check file extension
        const fileExt = path.extname(options.file).toLowerCase();
        if (fileExt !== '.json') {
          printWarning('File extension is not .json', { extension: fileExt });
        }

        const fileStats = fs.statSync(options.file);

        // Check file size
        if (fileStats.size > FILE_SIZE_LIMITS.PIPELINE_PROPS) {
          printError('Properties file is too large', {
            size: formatFileSize(fileStats.size),
            limit: formatFileSize(FILE_SIZE_LIMITS.PIPELINE_PROPS),
          });
          throw new Error('Properties file exceeds size limit');
        }

        printSuccess('File validation passed');
        printKeyValue({
          'File Path': options.file,
          'File Size': formatFileSize(fileStats.size),
          'Extension': fileExt,
        });

        // Read and parse properties file
        console.log('');
        printInfo('Reading pipeline properties...');

        const fileContent = fs.readFileSync(options.file, 'utf-8');

        let props: Record<string, unknown>;
        try {
          props = JSON.parse(fileContent);
        } catch (error) {
          printError('Invalid JSON in properties file', {
            error: error instanceof Error ? error.message : String(error),
            hint: 'Ensure the file contains valid JSON syntax',
          });
          throw new Error('Properties file must contain valid JSON');
        }

        // Validate properties structure
        if (typeof props !== 'object' || props === null) {
          printError('Invalid properties format', {
            type: typeof props,
            hint: 'Properties must be a JSON object',
          });
          throw new Error('Properties must be a valid object');
        }

        const propCount = Object.keys(props).length;

        printSuccess('Properties parsed successfully');
        printKeyValue({
          'Total Keys': propCount.toString(),
          'Sample Keys': Object.keys(props).slice(0, 5).join(', ') + (propCount > 5 ? '...' : ''),
        });

        // Validate properties content
        if (propCount === 0) {
          printWarning('Properties object is empty - pipeline will have no configuration');
        }

        // Resolve project & organization: prefer CLI flags, fall back to
        // values embedded inside the props file (builderProps).
        const resolvedProject = options.project ?? (props.project as string | undefined);
        const resolvedOrganization = options.organization ?? (props.organization as string | undefined);

        if (!resolvedProject) {
          printError('Project is required', {
            hint: 'Provide -p/--project flag or include "project" in the props file',
          });
          throw new Error('Project is required');
        }
        if (!resolvedOrganization) {
          printError('Organization is required', {
            hint: 'Provide -o/--organization flag or include "organization" in the props file',
          });
          throw new Error('Organization is required');
        }

        // Build request payload — resolve pipelineName using same strategy as pipeline-builder.ts:
        //   props.pipelineName ?? `${organization}-${project}-pipeline`
        const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const resolvedPipelineName = options.name
          ?? (props.pipelineName as string | undefined)
          ?? `${sanitize(resolvedOrganization)}-${sanitize(resolvedProject)}-pipeline`;

        const payload: CreatePipelineRequest = {
          project: resolvedProject,
          organization: resolvedOrganization,
          pipelineName: resolvedPipelineName,
          props,
        };

        // Add optional fields only if provided
        if (options.access) {
          payload.accessModifier = options.access;
        }
        if (options.default !== undefined) {
          payload.isDefault = options.default;
        }
        if (options.active !== undefined) {
          payload.isActive = options.active;
        }

        // Dry run mode
        if (options.dryRun) {
          console.log('');
          printSection('Dry Run - Request Preview');
          console.log(JSON.stringify(payload, null, 2));
          console.log('');
          printSuccess('✓ Validation complete - no pipeline created (dry run mode)');
          console.log('');
          printInfo('To create the pipeline, run the command without --dry-run');
          return;
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
          'Endpoint': config.api.pipelinePostUrl,
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

        // Create pipeline
        console.log('');
        printSection('Creating Pipeline');
        printInfo('Sending request to API...');

        const requestStart = Date.now();
        const rawResponse = await client.post<any>(
          config.api.pipelinePostUrl,
          payload,
        );
        const requestDuration = Date.now() - requestStart;

        // Unwrap potential response envelopes: { data: Pipeline }, { pipeline: Pipeline }, or bare Pipeline
        const pipeline: Pipeline =
          rawResponse?.id !== undefined ? rawResponse :
            rawResponse?.data?.id !== undefined ? rawResponse.data :
              rawResponse?.pipeline?.id !== undefined ? rawResponse.pipeline :
                rawResponse;

        if (!pipeline?.id) {
          printError('Invalid pipeline response', {
            responseKeys: rawResponse ? Object.keys(rawResponse) : '(null)',
          });
          throw new Error('Pipeline creation failed - no valid pipeline data received');
        }

        console.log('');
        printSection('✓ Pipeline Created Successfully');

        // Display created pipeline info
        printKeyValue({
          'Pipeline ID': green(bold(pipeline.id)),
          'Project': pipeline.project,
          'Organization': pipeline.organization,
          'Name': pipeline.pipelineName || '(not set)',
          'Access': pipeline.accessModifier || 'private',
          'Default': pipeline.isDefault ? 'Yes' : 'No',
          'Active': pipeline.isActive ? 'Yes' : 'No',
          'Properties': pipeline.props ? `${Object.keys(pipeline.props).length} keys` : '(not returned)',
        });

        if (pipeline.createdAt) {
          console.log('');
          printKeyValue({
            'Created At': pipeline.createdAt,
          });
        }

        // Performance metrics
        console.log('');
        printKeyValue({
          'Execution ID': executionId,
          'Request Duration': formatDuration(requestDuration),
          'Total Duration': formatDuration(Date.now() - startTime),
        });

        // Save pipeline info to file
        const outputDir = './output';
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputFile = path.join(outputDir, `pipeline-${pipeline.id}.json`);
        fs.writeFileSync(outputFile, JSON.stringify(pipeline, null, 2));

        console.log('');
        printSuccess('Pipeline details saved to file');
        printKeyValue({
          'Output File': outputFile,
          'File Size': formatFileSize(fs.statSync(outputFile).size),
        });

        // Next steps
        console.log('');
        printSection('Next Steps');
        console.log(dim('You can now:'));
        console.log(`  ${cyan('•')} Deploy: ${bold(`deploy --id ${pipeline.id}`)}`);
        console.log(`  ${cyan('•')} View: ${bold(`get-pipeline --id ${pipeline.id}`)}`);
        console.log(`  ${cyan('•')} API: ${config.api.baseUrl}${config.api.pipelineUrl}/${pipeline.id}`);
        console.log('');

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'create-pipeline',
            executionId,
            project: options.project,
            organization: options.organization,
            file: options.file,
            verifySsl: options.verifySsl,
            dryRun: options.dryRun,
          },
        });
      }
    });
}