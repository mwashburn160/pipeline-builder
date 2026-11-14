// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning, validateEntityId, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printInfo, printSuccess, printWarning } from '../utils/output-utils.js';

/** `--yes` is required: both verbs are destructive and the CLI never prompts. */
function requireYes(yes: boolean | undefined, what: string): void {
  if (!yes) throw new ValidationError(`Refusing to ${what} without --yes`, 'yes');
}

/**
 * Registers `pipeline delete`: delete a pipeline configuration
 * (`DELETE /api/pipelines/:id`). It does NOT touch AWS — a deployed stack keeps
 * running until it is destroyed, and the stack then shows up in `audit stacks`
 * as orphaned.
 *
 * @example
 * ```bash
 * pipeline-manager pipeline delete --id <pipelineId> --yes
 * ```
 */
export function deletePipeline(program: Command): void {
  withSslOptions(program
    .command('delete')
    .description('Delete a pipeline configuration from the platform (the deployed stack, if any, is left in AWS)')
    .requiredOption('-i, --id <id>', 'Pipeline ID')
    .option('-y, --yes', 'Confirm the deletion (required)', false))
    .action(async (options) => {
      const executionId = printCommandHeader('Delete Pipeline');
      try {
        printSslWarning(options.verifySsl);
        const id = validateEntityId(options.id, 'Pipeline');
        requireYes(options.yes, 'delete a pipeline');
        const client = await createAuthenticatedClientAsync(options);
        await client.delete(`${client.getConfig().api.pipelineUrl}/${encodeURIComponent(id)}`);
        printSuccess('Pipeline deleted', { id });
        printWarning('A deployed stack is not removed — destroy it in AWS, or it will be reported by "audit stacks" as orphaned');
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          exit: true,
          context: { command: 'pipeline-delete', executionId, pipelineId: options.id },
        });
      }
    });
}

/**
 * Registers `pipeline deregister`: remove one pipeline_registry row
 * (`DELETE /api/pipelines/registry/:id`, by the row's UUID — the `registryId`
 * an `audit stacks` missing-stack finding prints). The supported way to clear a
 * row whose CloudFormation stack was deleted out of band.
 *
 * @example
 * ```bash
 * pipeline-manager pipeline deregister --id <registryId> --yes
 * ```
 */
export function deregisterPipeline(program: Command): void {
  withSslOptions(program
    .command('deregister')
    .description('Remove a pipeline_registry row (by registry id) — reconciles an "audit stacks" missing-stack finding')
    .requiredOption('-i, --id <registryId>', 'Registry row ID (the registryId "audit stacks" prints)')
    .option('-y, --yes', 'Confirm the removal (required)', false))
    .action(async (options) => {
      const executionId = printCommandHeader('Deregister Pipeline');
      try {
        printSslWarning(options.verifySsl);
        const id = validateEntityId(options.id, 'Registry');
        requireYes(options.yes, 'remove a registry row');
        const client = await createAuthenticatedClientAsync(options);
        await client.delete(`${client.getConfig().api.pipelineUrl}/registry/${encodeURIComponent(id)}`);
        printSuccess('Registry row removed', { id });
        printInfo('Event reporting for that deployment stops; "pipeline register" adds it back');
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          exit: true,
          context: { command: 'pipeline-deregister', executionId, registryId: options.id },
        });
      }
    });
}
