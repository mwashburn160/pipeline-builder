// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { runListEntity } from './entity-list.js';
import { validateBoolean } from '../config/cli.constants.js';
import { type Pipeline } from '../types/index.js';
import { withSslOptions } from '../utils/command-utils.js';
import { type CommonFilterParams } from '../utils/list-command-utils.js';

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
 * cli pipeline list
 * cli pipeline list --project my-app --is-active true
 * cli pipeline list --organization my-org
 * cli pipeline list --limit 50 --offset 100 --sort "pipelineName:asc"
 * cli pipeline list --format json --output pipelines.json
 * ```
 */
export function listPipelines(program: Command): void {
  withSslOptions(program
    .command('list')
    .description('Query pipelines with comprehensive filters')

    // Common filter options
    .option('--id <id>', 'Filter by pipeline ID (can specify multiple with commas)')
    .option('--access-modifier <modifier>', 'Filter by access modifier (public/private)')
    .option('--is-default <boolean>', 'Filter by default status (true/false)')
    .option('--is-active <boolean>', 'Filter by active status (true/false)')
    .option('--limit <number>', 'Maximum number of results (1-1000)', (v) => parseInt(v, 10), 50)
    .option('--offset <number>', 'Number of results to skip', (v) => parseInt(v, 10), 0)
    .option('--sort <sort>', 'Sort format: field:direction (e.g., pipelineName:asc, createdAt:desc)')

    // Pipeline-specific filter options
    .option('--project <project>', 'Filter by exact project name')
    .option('--organization <organization>', 'Filter by exact organization name')
    .option('--pipeline-name <name>', 'Filter by exact pipeline name')

    // Output options
    .option('-f, --format <format>', 'Output format (json, yaml, table, csv)', 'table')
    .option('-o, --output <file>', 'Save output to file')
    .option('--show-props', 'Include pipeline properties in output (json/yaml only)', false))

    .action((options) => runListEntity<Pipeline, PipelineFilterParams>(program, options, {
      labelPlural: 'Pipelines',
      responseKey: 'pipelines',
      listUrl: (config) => config.api.pipelineListUrl,
      commandName: 'list-pipelines',
      buildFilters: (options, base) => {
        const filters: PipelineFilterParams = { ...base };
        if (options.accessModifier) filters.accessModifier = options.accessModifier as string;
        if (options.isDefault !== undefined) filters.isDefault = validateBoolean(options.isDefault as string, 'is-default');
        if (options.project) filters.project = options.project as string;
        if (options.organization) filters.organization = options.organization as string;
        if (options.pipelineName) filters.pipelineName = options.pipelineName as string;
        return filters;
      },
      activeFilters: (filters) => {
        const active: Record<string, unknown> = {};
        if (filters.id) active.ID = filters.id;
        if (filters.accessModifier) active['Access Modifier'] = filters.accessModifier;
        if (filters.isDefault !== undefined) active['Is Default'] = filters.isDefault;
        if (filters.isActive !== undefined) active['Is Active'] = filters.isActive;
        if (filters.project) active.Project = filters.project;
        if (filters.organization) active.Organization = filters.organization;
        if (filters.pipelineName) active['Pipeline Name'] = filters.pipelineName;
        return active;
      },
      statistics: (pipelines) => ({
        'Active Pipelines': `${pipelines.filter(p => p.isActive).length}/${pipelines.length}`,
        'Default Pipelines': `${pipelines.filter(p => p.isDefault).length}/${pipelines.length}`,
      }),
      rows: (pipelines, options) => options.showProps ? pipelines : pipelines.map(p => ({
        'ID': p.id,
        'Project': p.project,
        'Organization': p.organization,
        'Name': p.pipelineName || 'N/A',
        'Access Modifier': p.accessModifier || 'private',
        'Default': p.isDefault ? 'Yes' : 'No',
        'Active': p.isActive ? 'Yes' : 'No',
        'Created At': p.createdAt || 'N/A',
      })),
    }));
}
