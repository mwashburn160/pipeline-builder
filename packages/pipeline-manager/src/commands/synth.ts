// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from '@pipeline-builder/api-core';
import { formatSynthFailure, synthFailure } from '@pipeline-builder/pipeline-core';
import { Command } from 'commander';
import { assertShellSafe } from '../config/cli.constants.js';
import type { ApiClient } from '../utils/api-client.js';
import { auditLog } from '../utils/audit-log.js';
import { executeCdkShellCommand, resolveBoilerplatePath } from '../utils/cdk-utils.js';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning, withProfileOption, withRegionOption, withSslOptions } from '../utils/command-utils.js';
import { registerPipeline } from '../utils/deploy-runner.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { type FetchedPipeline, fetchPipelineProps, printResolvedOrExit } from '../utils/pipeline-config.js';
import { PluginResolutionError, printLookupWarningSummary } from '../utils/plugin-resolver.js';
import { resolveRegistrationClient } from '../utils/registration-client.js';
import { setPipelineId } from '../utils/request-context.js';
import { relaxTlsForCli } from '../utils/tls.js';

// ESM has no __dirname; derive it from this module's URL.
const __dirname = dirname(fileURLToPath(import.meta.url));

/** What a fetched synth needs afterwards to register the step manifest. */
interface FetchedForSynth {
  client: ApiClient;
  pipeline: FetchedPipeline['pipeline'];
  pluginWarnings: FetchedPipeline['pluginWarnings'];
}

/**
 * Fetch pipeline config and set PIPELINE_PROPS env var for the boilerplate app.
 * Uses createAuthenticatedClientAsync which supports all three auth methods.
 */
async function fetchPipelineConfig(
  pipelineId: string,
  options: { storeTokens?: boolean; verifySsl?: boolean; region?: string; profile?: string },
): Promise<FetchedForSynth> {
  const client = await createAuthenticatedClientAsync(options);
  const { pipeline, propsWithIds, baseUrl, pluginWarnings } = await fetchPipelineProps(client, pipelineId);

  process.env.PIPELINE_PROPS = Buffer.from(JSON.stringify(propsWithIds)).toString('base64');

  // Propagate the resolved platform base URL into the boilerplate synth (which
  // inherits process.env). The synth uses it for serverConfig.platformUrl (the
  // PluginLookup Lambda endpoint) and as the loadRegistryConfig pull-host
  // fallback. Without this, a URL configured via ~/.pipeline-manager/config.yml
  // is invisible to the synth subprocess (it reads only the env).
  if (baseUrl) {
    process.env.PLATFORM_BASE_URL = baseUrl;
  }

  printSuccess('Pipeline configuration loaded');
  return { client, pipeline: { ...pipeline, id: pipeline.id || pipelineId }, pluginWarnings };
}

/** True inside an AWS CodeBuild build (the self-mutating synth). */
function inCodeBuild(): boolean {
  return !!process.env.CODEBUILD_BUILD_ID;
}

/**
 * Print the one-line machine-readable failure (`PB_SYNTH_FAILURE {…}`) the
 * events Lambda lifts out of the failed build's log and attaches to the
 * execution event. Only inside CodeBuild — elsewhere a human reads the error.
 */
export function emitSynthFailure(error: unknown): void {
  if (!inCodeBuild()) return;
  const failure = error instanceof PluginResolutionError
    ? synthFailure(error.message, error.refusals)
    : synthFailure(errorMessage(error));
  console.error(formatSynthFailure(failure));
}

/**
 * Registers the `synth` command with the CLI program.
 *
 * Runs CDK synthesis using the boilerplate app. Pipeline config is resolved from:
 * 1. --id flag or PIPELINE_ID env var → fetches config from platform API
 * 2. PIPELINE_PROPS env var (pre-encoded, from deploy command)
 *
 * Authentication methods (in priority order):
 * - PLATFORM_TOKEN env var
 * - --store-tokens → fetch from AWS Secrets Manager
 *
 * @example
 * ```bash
 * pipeline-manager pipeline synth --id <pipeline-id>
 * pipeline-manager pipeline synth --id <pipeline-id> --store-tokens
 * pipeline-manager pipeline synth --quiet --no-notices          # CodePipeline (uses env vars)
 * ```
 */
export function synth(program: Command): void {
  withSslOptions(
    withRegionOption(
      withProfileOption(program
        .command('synth')
        .description('Run CDK synthesis using pipeline configuration')
        .option('-i, --id <id>', 'Pipeline ID (or set PIPELINE_ID env var)')
        .option('--store-tokens', 'Authenticate using token from AWS Secrets Manager (requires PLATFORM_SECRET_NAME env var)', false)
        .option('--output <dir>', 'CDK output directory', 'cdk.out')),
    )
      .option('--quiet', 'Suppress CDK output', false)
      .option('--no-notices', 'Suppress CDK notices')
      .option('--verbose', 'Show verbose CDK output', false)
      .option('--json', 'Output result as JSON', false),
  )
    .option('--show-resolved', 'Print the resolved pipeline config (with {{ ... }} templates expanded) and exit without running CDK', false)
    .action(async (options) => {
      const executionId = printCommandHeader('CDK Synthesis', undefined, { quiet: options.json });

      try {
        const pipelineId = options.id || process.env.PIPELINE_ID;
        // Every platform call below carries it, so the usage ledger can say which
        // pipeline's synth spent the calls.
        setPipelineId(pipelineId);

        // --show-resolved: preview templates and exit
        if (options.showResolved) {
          await showResolvedPipeline(pipelineId, options);
          return;
        }

        auditLog('synth', { executionId, pipelineId, output: options.output, profile: options.profile });
        printSslWarning(options.verifySsl);

        // Propagate to process.env so CDK constructs (Lambda, CodeBuild) inherit it,
        // but refuse in production (see relaxTlsForCli) — the flag disables cert
        // validation for ALL outbound TLS, including the AWS SDK.
        relaxTlsForCli(options.verifySsl, printWarning);

        // Fetch pipeline config if ID is available and PIPELINE_PROPS not already set
        let fetched: FetchedForSynth | undefined;
        if (pipelineId && !process.env.PIPELINE_PROPS) {
          printInfo('Fetching pipeline configuration', { id: pipelineId });
          fetched = await fetchPipelineConfig(pipelineId, options);
        } else if (!pipelineId && !process.env.PIPELINE_PROPS) {
          printWarning('No pipeline ID or PIPELINE_PROPS set');
          throw new Error('Pipeline ID is required. Use --id <id> or set PIPELINE_ID env var.');
        }

        // Local-tool prerequisites (cdk + esbuild/pnpm) are verified up front by
        // the CLI's preAction hook, so by here they're guaranteed present.

        // Build cdk synth command
        if (options.output) assertShellSafe(options.output, 'output');
        if (options.profile) assertShellSafe(options.profile, 'profile');

        const boilerplatePath = resolveBoilerplatePath(__dirname);
        const parts = [
          'cdk synth',
          `--app="node ${boilerplatePath}"`,
          `--output=${options.output}`,
        ];

        if (options.profile) parts.push(`--profile=${options.profile}`);
        if (options.quiet) parts.push('--quiet');
        if (options.notices === false) parts.push('--no-notices');
        if (options.verbose) parts.push('--verbose');

        const command = parts.join(' ');

        printInfo('Executing', { command: (command.split('--app')[0] ?? '').trim() + ' ...' });
        console.log('');

        const result = executeCdkShellCommand(command, {
          showOutput: !options.quiet,
        });

        console.log('');
        printSection('Synthesis Complete');

        // A self-mutating pipeline re-synthesizes in CodeBuild on every run and
        // never passes through `pipeline deploy`, so register its step manifest
        // here — otherwise the platform keeps the digests of the LAST manual
        // deploy and its deployed-exposure view goes stale. Best-effort: a
        // failed registration is logged loudly, never fails the synth.
        //
        // Registered with the `pipeline-register` key, NOT the platform key the
        // synth fetched with: that one reads pipelines and plugins only. A
        // missing registration key skips this with a warning (no fallback).
        if (result.success && fetched && inCodeBuild()) {
          const registrationClient = await resolveRegistrationClient({
            client: fetched.client,
            storeTokens: options.storeTokens,
            orgId: fetched.pipeline.orgId,
            region: options.region,
            profile: options.profile,
          });
          if (registrationClient) {
            await registerPipeline({
              client: registrationClient,
              pipelineUrl: registrationClient.getConfig().api.pipelineUrl,
              pipeline: fetched.pipeline,
              region: options.region,
              output: options.output,
              queueOnFailure: false,
            });
          }
        }

        // Vulnerability/lifecycle state is reported, never enforced: one graded
        // summary line so the warnings printed during resolution aren't lost
        // above the CDK output.
        if (fetched) printLookupWarningSummary(fetched.pluginWarnings);

        if (result.success) {
          if (options.json) {
            console.log(JSON.stringify({
              success: true,
              executionId,
              duration: result.duration,
              output: options.output,
            }, null, 2));
          } else {
            printKeyValue({
              'Execution ID': executionId,
              'Duration': `${result.duration}ms`,
              'Output': options.output,
              'Status': '✓ Success',
            });
          }
        }

      } catch (error) {
        emitSynthFailure(error);
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'synth', executionId, pipelineId: options.id },
        });
      }
    });
}

/**
 * Fetch the pipeline by ID, apply pass-1 self-referencing template
 * resolution, and print it to stdout. Used by `synth --show-resolved`
 * and `deploy --show-resolved` to preview substitution before running CDK.
 */
async function showResolvedPipeline(
  pipelineId: string | undefined,
  options: { profile?: string; region?: string; storeTokens?: boolean; verifySsl?: boolean },
): Promise<void> {
  if (!pipelineId) {
    throw new Error('--show-resolved requires --id or PIPELINE_ID env var');
  }
  const client = await createAuthenticatedClientAsync(options);
  const { propsWithIds } = await fetchPipelineProps(client, pipelineId);
  await printResolvedOrExit(propsWithIds);
}
