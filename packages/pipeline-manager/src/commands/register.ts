// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { Pipeline, PipelineResponse } from '../types';
import { createAuthenticatedClient, printCommandHeader, printSslWarning } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { extractSingleResponse, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';
import {
  buildRegistryPayload,
  clearPendingIntent,
  readPendingIntents,
  writePendingIntent,
  type RegistryPayload,
} from '../utils/registry';

/**
 * Registers the `register` command with the CLI program.
 *
 * Two purposes — both targeted at recovering from a deploy whose registration
 * step didn't land:
 *
 *   1. Explicit re-register (`--id <pipelineId>`) — recomputes the ARN from
 *      STS + region and POSTs it to the platform. Useful when the platform
 *      was unreachable during `deploy`, when the registry row was deleted by
 *      mistake, or for any other reason a deployed stack has no registry row.
 *
 *   2. Drain pending intents (every invocation) — `deploy` writes a local
 *      file under `~/.pipeline-manager/pending-registrations/` whenever its
 *      registration POST fails. Each `register` invocation tries to drain
 *      every such file. On success the file is deleted; on failure it stays
 *      and surfaces as a warning.
 *
 * Flags:
 *   - `--id <pipelineId>` — re-register a specific pipeline by ID
 *   - `--region <region>` — AWS region (default: AWS_REGION env / us-east-1)
 *   - `--no-drain` — skip draining pending intents
 *
 * Exit codes:
 *   - 0: requested registration succeeded AND no pending intents remain
 *   - 1: at least one registration (explicit or pending) still failed
 *
 * @example
 * ```bash
 * # Retry a registration that failed during deploy
 * pipeline-manager register --id pipe-123
 *
 * # Just drain pending intents from disk, no specific registration
 * pipeline-manager register
 * ```
 */
export function register(program: Command): void {
  program
    .command('register')
    .description('Register a deployed pipeline ARN with the platform (retry path for failed registrations)')
    .option('-i, --id <id>', 'Pipeline ID to register (re-derives ARN from STS)')
    .option('--region <region>', 'AWS region (defaults to AWS_REGION env)')
    .option('--no-drain', 'Skip draining pending intents from prior failed deploys')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .action(async (options) => {
      const executionId = printCommandHeader('Register Pipeline');
      printSslWarning(options.verifySsl);

      let anyFailed = false;
      let registeredCount = 0;

      try {
        const client = createAuthenticatedClient(options);
        const pipelineUrl = client.getConfig().api.pipelineUrl;

        // ── Drain pending intents first ──
        // We drain before the explicit registration so a queued failure for
        // the same pipelineId is replaced (not double-applied) by the fresh
        // payload below.
        const drained = new Set<string>();
        if (options.drain !== false) {
          const intents = await readPendingIntents();
          if (intents.length > 0) {
            printSection('Draining pending intents');
            printInfo('Found pending registrations from prior failed deploys', {
              count: String(intents.length),
            });
            for (const intent of intents) {
              // Skip the explicit pipeline — we'll re-build a fresh payload below.
              if (options.id && intent.pipelineId === options.id) continue;
              const ok = await postRegistration(client, pipelineUrl, intent, intent.pipelineId);
              if (ok) {
                await clearPendingIntent(intent.pipelineId);
                drained.add(intent.pipelineId);
                registeredCount++;
              } else {
                anyFailed = true;
              }
            }
          }
        }

        // ── Explicit registration ──
        if (options.id) {
          printSection('Re-registering pipeline');
          const pipelineRes = await client.get<PipelineResponse>(`${pipelineUrl}/${options.id}`);
          const pipeline = extractSingleResponse<Pipeline>(pipelineRes, 'pipeline', 'id');
          if (!pipeline) {
            printError('Pipeline not found in platform');
            throw new Error(`No pipeline returned for id ${options.id}`);
          }

          const payload = await buildRegistryPayload(
            {
              id: pipeline.id,
              orgId: pipeline.orgId,
              pipelineName: pipeline.pipelineName,
              project: pipeline.project,
              organization: pipeline.organization,
            },
            options.region,
          );

          // Clear any stale intent for this pipelineId before retrying so we
          // don't leave a duplicate file behind on success.
          await clearPendingIntent(payload.pipelineId);

          const ok = await postRegistration(client, pipelineUrl, payload, payload.pipelineId);
          if (ok) {
            registeredCount++;
            printSuccess('Pipeline registered for event reporting', {
              arn: payload.pipelineArn,
            });
          } else {
            anyFailed = true;
            const path = await writePendingIntent(payload);
            printWarning('Registration failed; intent saved for retry', { intent: path });
          }
        }

        printSection('Summary');
        printKeyValue({
          'Registered': String(registeredCount),
          'Drained from queue': String(drained.size),
          'Status': anyFailed ? 'Some registrations still pending' : 'All clear',
          'Execution ID': executionId,
        });

        process.exit(anyFailed ? 1 : 0);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: false,
          context: { command: 'register', executionId, pipelineId: options.id },
        });
        process.exit(1);
      }
    });
}

/**
 * POST a registration payload to the platform. On failure, the caller decides
 * whether to write/preserve a pending intent — this helper just reports.
 */
async function postRegistration(
  client: ReturnType<typeof createAuthenticatedClient>,
  pipelineUrl: string,
  payload: RegistryPayload,
  pipelineId: string,
): Promise<boolean> {
  try {
    await client.post(`${pipelineUrl}/registry`, payload);
    printInfo('Registered', { pipelineId, arn: payload.pipelineArn });
    return true;
  } catch (err) {
    printWarning('Registration failed', {
      pipelineId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
