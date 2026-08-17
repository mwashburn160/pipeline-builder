// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { formatDuration, type OutputFormat } from '../config/cli.constants.js';
import { createAuthenticatedClient, printCommandHeader, printSslWarning } from '../utils/command-utils.js';
import { type Config } from '../utils/config-loader.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { buildCommonFilters, type CommonFilterParams, displayListResults, displayPaginationInfo } from '../utils/list-command-utils.js';
import { extractListResponse, outputData, printInfo, printKeyValue, printSection } from '../utils/output-utils.js';

/**
 * Per-entity configuration for {@link runListEntity}. Captures everything that
 * differs between `list-pipelines` and `list-plugins`; the surrounding scaffold
 * (header, filter display, pagination, query, results summary, output, perf
 * metrics, error handling) is identical and lives in the runner.
 */
export interface ListEntitySpec<TItem, TFilter extends CommonFilterParams> {
  /** Plural title-case label, e.g. `'Pipelines'`. Drives headers and messages. */
  labelPlural: string;
  /** Response-envelope key the items are nested under, e.g. `'pipelines'`. */
  responseKey: string;
  /** Build the list URL from the resolved config. */
  listUrl: (config: Config) => string;
  /** Merge entity-specific filters onto the common (pagination/sort) base. */
  buildFilters: (options: Record<string, unknown>, base: CommonFilterParams) => TFilter;
  /** Human-readable active-filter map shown before the query. */
  activeFilters: (filters: TFilter) => Record<string, unknown>;
  /** Optional table-only statistics block; return `null` to omit. */
  statistics?: (items: TItem[]) => Record<string, unknown> | null;
  /** Rows to serialize (full items when the show-flag is set, else a slim map). */
  rows: (items: TItem[], options: Record<string, unknown>) => unknown;
  /** Command name for error-handler context, e.g. `'list-pipelines'`. */
  commandName: string;
}

/**
 * Shared implementation of the list commands. Applies common + entity-specific
 * filters, queries the API, prints a results summary (and optional statistics),
 * and writes the rows in the requested format.
 */
export async function runListEntity<TItem, TFilter extends CommonFilterParams>(
  program: Command,
  options: Record<string, unknown> & { format?: OutputFormat; output?: string; verifySsl?: boolean },
  spec: ListEntitySpec<TItem, TFilter>,
): Promise<void> {
  const executionId = printCommandHeader(`List ${spec.labelPlural}`, `Query ${spec.labelPlural}`);
  const startTime = Date.now();

  try {
    const filterParams = spec.buildFilters(options, buildCommonFilters(options));

    // Display active filters
    const activeFilters = spec.activeFilters(filterParams);
    if (Object.keys(activeFilters).length > 0) {
      printInfo('Active Filters');
      printKeyValue(activeFilters);
    } else {
      printInfo(`No filters applied - fetching all ${spec.labelPlural.toLowerCase()}`);
    }

    displayPaginationInfo(filterParams);

    // Security warning for SSL verification disabled
    printSslWarning(options.verifySsl);

    // Create authenticated API client
    const client = createAuthenticatedClient(options);
    const config = client.getConfig();

    // Query
    console.log('');
    printSection(`Querying ${spec.labelPlural}`);
    printInfo('Sending request to API...');

    const requestStart = Date.now();
    const response = await client.get(
      spec.listUrl(config),
      filterParams as Record<string, unknown>,
    );
    const requestDuration = Date.now() - requestStart;

    // Handle response
    const { items, total, hasMore } = extractListResponse<TItem>(response, spec.responseKey);

    console.log('');
    printSection('✓ Query Complete');

    // Display results summary
    displayListResults(items, total, hasMore, spec.labelPlural, requestDuration, filterParams);

    // Display statistics
    if (items.length > 0 && options.format === 'table') {
      const stats = spec.statistics?.(items);
      if (stats) {
        console.log('');
        printInfo('Statistics');
        printKeyValue(stats);
      }
    }

    // Output data in requested format
    console.log('');
    if (options.output) {
      printInfo('Saving to file', { path: options.output, format: options.format });
    }

    outputData(spec.rows(items, options), {
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
        command: spec.commandName,
        executionId,
        filters: options,
        verifySsl: options.verifySsl,
      },
    });
  }
}
