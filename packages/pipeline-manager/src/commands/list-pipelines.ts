import { Command } from 'commander';
import { formatDuration, validateBoolean } from '../config/cli.constants';
import { PipelineListResponse, Pipeline } from '../types';
import { printCommandHeader, printSslWarning, createAuthenticatedClient } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { buildCommonFilters, CommonFilterParams, displayPaginationInfo, displayListResults } from '../utils/list-command-utils';
import { outputData, extractListResponse, printInfo, printKeyValue, printSection } from '../utils/output-utils';

/**
 * Query parameters for the pipeline list API endpoint.
 * Combines common filters (pagination, sort, access) with pipeline-specific filters.
 */
interface PipelineFilterParams extends CommonFilterParams {
  accessModifier?: string;
  isDefault?: boolean;

  // Pipeline-specific filters
  project?: string;
  organization?: string;
  pipelineName?: string;
}

/**
 * Registers the `list-pipelines` command with the CLI program.
 *
 * Queries pipelines with filters for project, organization, name,
 * access modifier, active/default status, plus pagination and sorting.
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * cli list-pipelines
 * cli list-pipelines --project my-app --is-active true
 * cli list-pipelines --organization my-org
 * cli list-pipelines --limit 50 --offset 100 --sort "pipelineName:asc"
 * cli list-pipelines --format json --output pipelines.json
 * ```
 */
export function listPipelines(program: Command): void {
  program
    .command('list-pipelines')
    .description('Query pipelines with comprehensive filters')

    // Common filter options
    .option('--id <id>', 'Filter by pipeline ID (can specify multiple with commas)')
    .option('--access-modifier <modifier>', 'Filter by access modifier (public/private)')
    .option('--is-default <boolean>', 'Filter by default status (true/false)')
    .option('--is-active <boolean>', 'Filter by active status (true/false)')
    .option('--limit <number>', 'Maximum number of results (1-1000)', parseInt, 50)
    .option('--offset <number>', 'Number of results to skip', parseInt, 0)
    .option('--sort <sort>', 'Sort format: field:direction (e.g., pipelineName:asc, createdAt:desc)')

    // Pipeline-specific filter options
    .option('--project <project>', 'Filter by exact project name')
    .option('--organization <organization>', 'Filter by exact organization name')
    .option('--pipeline-name <name>', 'Filter by exact pipeline name')

    // Output options
    .option('-f, --format <format>', 'Output format (json, yaml, table, csv)', 'table')
    .option('-o, --output <file>', 'Save output to file')
    .option('--show-props', 'Include pipeline properties in output (json/yaml only)', false)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')

    .action(async (options) => {
      const executionId = printCommandHeader('List Pipelines', 'Query Pipelines');
      const startTime = Date.now();

      try {

        // Build filter parameters (common + pipeline-specific)
        const filterParams: PipelineFilterParams = {
          ...buildCommonFilters(options),
        };

        // Pipeline-specific filters
        if (options.accessModifier) {
          filterParams.accessModifier = options.accessModifier;
        }

        if (options.isDefault !== undefined) {
          filterParams.isDefault = validateBoolean(options.isDefault, 'is-default');
        }

        if (options.project) {
          filterParams.project = options.project;
        }

        if (options.organization) {
          filterParams.organization = options.organization;
        }

        if (options.pipelineName) {
          filterParams.pipelineName = options.pipelineName;
        }

        // Display active filters
        const activeFilters: Record<string, unknown> = {};
        if (filterParams.id) activeFilters.ID = filterParams.id;
        if (filterParams.accessModifier) activeFilters['Access Modifier'] = filterParams.accessModifier;
        if (filterParams.isDefault !== undefined) activeFilters['Is Default'] = filterParams.isDefault;
        if (filterParams.isActive !== undefined) activeFilters['Is Active'] = filterParams.isActive;
        if (filterParams.project) activeFilters.Project = filterParams.project;
        if (filterParams.organization) activeFilters.Organization = filterParams.organization;
        if (filterParams.pipelineName) activeFilters['Pipeline Name'] = filterParams.pipelineName;

        if (Object.keys(activeFilters).length > 0) {
          printInfo('Active Filters');
          printKeyValue(activeFilters);
        } else {
          printInfo('No filters applied - fetching all pipelines');
        }

        displayPaginationInfo(filterParams);

        // Security warning for SSL verification disabled
        printSslWarning(options.verifySsl);

        // Create authenticated API client
        const client = createAuthenticatedClient(options);
        const config = client.getConfig();

        // Query pipelines
        console.log('');
        printSection('Querying Pipelines');
        printInfo('Sending request to API...');

        const requestStart = Date.now();
        const response = await client.get<PipelineListResponse>(
          config.api.pipelineListUrl,
          filterParams as Record<string, unknown>,
        );
        const requestDuration = Date.now() - requestStart;

        // Handle response
        const { items: pipelines, total, hasMore } = extractListResponse<Pipeline>(response, 'pipelines');

        console.log('');
        printSection('✓ Query Complete');

        // Display results summary
        displayListResults(pipelines, total, hasMore, 'Pipelines', requestDuration, filterParams);

        // Display statistics
        if (pipelines.length > 0 && options.format === 'table') {
          const activeCount = pipelines.filter(p => p.isActive).length;
          const defaultCount = pipelines.filter(p => p.isDefault).length;

          console.log('');
          printInfo('Statistics');
          printKeyValue({
            'Active Pipelines': `${activeCount}/${pipelines.length}`,
            'Default Pipelines': `${defaultCount}/${pipelines.length}`,
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
        const outputPipelines = options.showProps ? pipelines : pipelines.map(p => ({
          'ID': p.id,
          'Project': p.project,
          'Organization': p.organization,
          'Name': p.pipelineName || 'N/A',
          'Access Modifier': p.accessModifier || 'private',
          'Default': p.isDefault ? 'Yes' : 'No',
          'Active': p.isActive ? 'Yes' : 'No',
          'Created At': p.createdAt || 'N/A',
        }));

        outputData(outputPipelines, {
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
            command: 'list-pipelines',
            executionId,
            filters: options,
            verifySsl: options.verifySsl,
          },
        });
      }
    });
}
