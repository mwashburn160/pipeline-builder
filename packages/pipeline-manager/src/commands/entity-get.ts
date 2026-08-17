// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import pico from 'picocolors';
import { type OutputFormat } from '../config/cli.constants.js';
import { ApiClient } from '../utils/api-client.js';
import { createAuthenticatedClient, printCommandHeader, printExecutionSummary, printSslWarning, validateEntityId } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { extractSingleResponse, outputData, printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils.js';

const { dim } = pico;

/** Options common to the single-entity `get` commands. */
export interface GetEntityOptions {
  id: string;
  format: OutputFormat;
  output?: string;
  verifySsl?: boolean;
  showProps?: boolean;
  showMetadata?: boolean;
}

/**
 * Per-entity configuration for {@link runGetEntity}. Captures everything that
 * differs between `get-pipeline` and `get-plugin`; the surrounding scaffold
 * (header, SSL warning, fetch, summary table, execution summary, file output,
 * error handling) is identical and lives in the runner.
 */
export interface GetEntitySpec<TEntity extends { id: string }> {
  /** Title-case entity label, e.g. `'Pipeline'`. Drives headers and messages. */
  label: string;
  /** Response-envelope key the entity is nested under, e.g. `'pipeline'`. */
  responseKey: string;
  /** Build the single-entity GET URL from the authenticated client. */
  urlFor: (client: ApiClient, id: string) => string;
  /** Ordered key/value summary rendered as a table. */
  summary: (entity: TEntity) => Record<string, unknown>;
  /**
   * Optional extra JSON block shown after the summary (pipeline properties /
   * plugin metadata). Return `null` to omit.
   */
  extra?: (options: GetEntityOptions, entity: TEntity) => { infoLabel: string; payload: object } | null;
  /** Command name for error-handler context, e.g. `'get-pipeline'`. */
  commandName: string;
  /** Key under which the id is reported in error context, e.g. `'pipelineId'`. */
  idContextKey: string;
}

/**
 * Shared implementation of the single-entity `get` commands. Fetches one entity
 * by ID, prints a summary (and optional properties/metadata block), and writes
 * the raw entity in the requested format.
 */
export async function runGetEntity<TEntity extends { id: string }>(
  program: Command,
  options: GetEntityOptions,
  spec: GetEntitySpec<TEntity>,
): Promise<void> {
  const executionId = printCommandHeader(`Get ${spec.label}`);
  const lower = spec.label.toLowerCase();

  try {
    printSslWarning(options.verifySsl);
    printInfo('Request parameters', {
      id: options.id,
      format: options.format,
      output: options.output || '(console)',
    });

    const entityId = validateEntityId(options.id, spec.label);
    const client = createAuthenticatedClient(options);

    console.log('');
    printSection(`Fetching ${spec.label}`);

    const startTime = Date.now();
    const response = await client.get(spec.urlFor(client, entityId));
    const duration = Date.now() - startTime;

    const entity = extractSingleResponse<TEntity>(response, spec.responseKey, 'id');
    if (!entity) {
      printError(`No ${lower} returned from API`);
      throw new Error(`Failed to retrieve ${lower} with ID: ${entityId}`);
    }

    console.log('');
    printSection(`${spec.label} Retrieved Successfully`);
    printKeyValue(spec.summary(entity));

    const extra = spec.extra?.(options, entity);
    if (extra) {
      console.log('');
      printInfo(extra.infoLabel, { keys: Object.keys(extra.payload).length });
      console.log(dim('─'.repeat(process.stdout.columns || 80)));
      console.log(JSON.stringify(extra.payload, null, 2));
      console.log(dim('─'.repeat(process.stdout.columns || 80)));
    }

    printExecutionSummary(executionId, duration);

    outputData(entity, {
      format: options.format,
      file: options.output,
      silent: false,
    });

    if (options.output) {
      console.log('');
      printSuccess(`${spec.label} data saved`, { path: options.output });
    }
  } catch (error) {
    handleError(error, ERROR_CODES.API_REQUEST, {
      debug: program.opts().debug,
      exit: true,
      context: { command: spec.commandName, executionId, [spec.idContextKey]: options.id },
    });
  }
}
