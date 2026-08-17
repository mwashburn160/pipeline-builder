// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { runListEntity } from './entity-list.js';
import { formatFileSize } from '../config/cli.constants.js';
import { type Plugin } from '../types/index.js';
import { type CommonFilterParams } from '../utils/list-command-utils.js';
import { printWarning } from '../utils/output-utils.js';

/**
 * Query parameters for the plugin list API endpoint.
 * Combines common filters (pagination, sort) with plugin-specific filters.
 */
interface PluginFilterParams extends CommonFilterParams {
  // Plugin-specific filters
  name?: string;
  version?: string;
}

/**
 * Registers the `list-plugins` command with the CLI program.
 *
 * Queries plugins with filters for name, version, image tag,
 * active status, plus pagination and sorting.
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * cli plugin list
 * cli plugin list --name auth-plugin --is-active true
 * cli plugin list --version "^1.0.0"
 * cli plugin list --limit 50 --offset 100 --sort "name:asc"
 * cli plugin list --format json --output plugins.json
 * ```
 */
export function listPlugins(program: Command): void {
  program
    .command('list')
    .description('Query plugins with comprehensive filters')

    // Common filter options
    .option('--id <id>', 'Filter by plugin ID (can specify multiple with commas)')
    .option('--is-active <boolean>', 'Filter by active status (true/false)')
    .option('--limit <number>', 'Maximum number of results (1-1000)', parseInt, 50)
    .option('--offset <number>', 'Number of results to skip', parseInt, 0)
    .option('--sort <sort>', 'Sort format: field:direction (e.g., name:asc, createdAt:desc)')

    // Plugin-specific filter options
    .option('--name <name>', 'Filter by exact plugin name')
    .option('--version <version>', 'Filter by version (supports semver, e.g., "^1.0.0")')

    // Output options
    .option('-f, --format <format>', 'Output format (json, yaml, table, csv)', 'table')
    .option('-o, --output <file>', 'Save output to file')
    .option('--show-metadata', 'Include full metadata in output (json/yaml only)', false)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')

    .action((options) => runListEntity<Plugin, PluginFilterParams>(program, options, {
      labelPlural: 'Plugins',
      responseKey: 'plugins',
      listUrl: (config) => config.api.pluginListUrl,
      commandName: 'list-plugins',
      buildFilters: (options, base) => {
        const filters: PluginFilterParams = { ...base };
        if (options.name) filters.name = options.name as string;
        if (options.version) {
          // Validate semver format
          const versionPattern = /^(\^|~)?(\d+)\.(\d+)\.(\d+)(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
          if (!versionPattern.test(options.version as string)) {
            printWarning(`Version "${options.version}" may not be valid semver format`);
          }
          filters.version = options.version as string;
        }
        return filters;
      },
      activeFilters: (filters) => {
        const active: Record<string, unknown> = {};
        if (filters.id) active.ID = filters.id;
        if (filters.isActive !== undefined) active['Is Active'] = filters.isActive;
        if (filters.name) active.Name = filters.name;
        if (filters.version) active.Version = filters.version;
        return active;
      },
      statistics: (plugins) => ({
        'Active Plugins': `${plugins.filter(p => p.isActive).length}/${plugins.length}`,
        'Public Plugins': `${plugins.filter(p => p.isPublic === true).length}/${plugins.length}`,
        'Total Size': formatFileSize(plugins.reduce((sum, p) => sum + (p.fileSize || 0), 0)),
      }),
      rows: (plugins, options) => options.showMetadata ? plugins : plugins.map(p => ({
        'ID': p.id,
        'Name': p.name,
        'Version': p.version,
        'Organization': p.organization,
        'Active': p.isActive ? 'Yes' : 'No',
        'Public': p.isPublic ? 'Yes' : 'No',
        'Size': p.fileSize ? formatFileSize(p.fileSize) : 'N/A',
        'Created At': p.createdAt || 'N/A',
      })),
    }));
}
