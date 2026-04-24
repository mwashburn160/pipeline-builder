// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { assertShellSafe } from '../config/cli.constants';
import type { Pipeline } from '../types/pipeline';
import { auditLog } from '../utils/audit-log';
import { ensureCdkAvailable, executeCdkShellCommand, resolveBoilerplatePath } from '../utils/cdk-utils';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { extractSingleResponse, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';

/**
 * Fetch pipeline config and set PIPELINE_PROPS env var for the boilerplate app.
 * Uses createAuthenticatedClientAsync which supports all three auth methods.
 */
async function fetchPipelineConfig(
  pipelineId: string,
  options: { storeTokens?: boolean; verifySsl?: boolean; region?: string; profile?: string },
): Promise<void> {
  const client = await createAuthenticatedClientAsync(options);
  const config = client.getConfig();

  const response = await client.get<Record<string, unknown>>(
    `${config.api.pipelineUrl}/${pipelineId}`,
  );

  const pipeline = extractSingleResponse<Pipeline>(response, 'pipeline', 'props');

  if (!pipeline?.props) {
    printError('Pipeline has no props', { id: pipelineId });
    throw new Error(`Failed to retrieve pipeline props for ID: ${pipelineId}`);
  }

  const propsWithIds: Record<string, unknown> = {
    ...pipeline.props as Record<string, unknown>,
    pipelineId: pipeline.id || pipelineId,
  };
  if (pipeline.orgId) propsWithIds.orgId = pipeline.orgId;

  process.env.PIPELINE_PROPS = Buffer.from(JSON.stringify(propsWithIds)).toString('base64');
  printSuccess('Pipeline configuration loaded');
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
 * pipeline-manager synth --id <pipeline-id> --no-verify-ssl
 * pipeline-manager synth --id <pipeline-id> --store-tokens
 * pipeline-manager synth --quiet --no-notices          # CodePipeline (uses env vars)
 * ```
 */
export function synth(program: Command): void {
  program
    .command('synth')
    .description('Run CDK synthesis using pipeline configuration')
    .option('-i, --id <id>', 'Pipeline ID (or set PIPELINE_ID env var)')
    .option('--store-tokens', 'Authenticate using token from AWS Secrets Manager (requires PLATFORM_SECRET_NAME env var)', false)
    .option('--output <dir>', 'CDK output directory', 'cdk.out')
    .option('--profile <profile>', 'AWS profile')
    .option('--region <region>', 'AWS region (for --store-tokens)')
    .option('--quiet', 'Suppress CDK output', false)
    .option('--no-notices', 'Suppress CDK notices')
    .option('--verbose', 'Show verbose CDK output', false)
    .option('--json', 'Output result as JSON', false)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--show-resolved', 'Print the resolved pipeline config (with {{ ... }} templates expanded) and exit without running CDK', false)
    .action(async (options) => {
      const executionId = printCommandHeader('CDK Synthesis');

      try {
        const pipelineId = options.id || process.env.PIPELINE_ID;

        // --show-resolved: preview templates and exit
        if (options.showResolved) {
          await showResolvedPipeline(pipelineId, options);
          return;
        }

        auditLog('synth', { executionId, pipelineId, output: options.output, profile: options.profile });
        printSslWarning(options.verifySsl);

        // Propagate to process.env so CDK constructs (Lambda, CodeBuild) inherit it
        if (options.verifySsl === false) {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        }

        // Fetch pipeline config if ID is available and PIPELINE_PROPS not already set
        if (pipelineId && !process.env.PIPELINE_PROPS) {
          printInfo('Fetching pipeline configuration', { id: pipelineId });
          await fetchPipelineConfig(pipelineId, options);
        } else if (!pipelineId && !process.env.PIPELINE_PROPS) {
          printWarning('No pipeline ID or PIPELINE_PROPS set');
          throw new Error('Pipeline ID is required. Use --id <id> or set PIPELINE_ID env var.');
        }

        ensureCdkAvailable();
        printSuccess('AWS CDK is available');

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
  await fetchPipelineConfig(pipelineId, options);
  // fetchPipelineConfig writes PIPELINE_PROPS base64-encoded on success
  const encoded = process.env.PIPELINE_PROPS;
  if (!encoded) throw new Error('Failed to fetch pipeline configuration');
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));

  // Lazy import to avoid pulling pipeline-core into every CLI invocation
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveSelfReferencing } = require('@pipeline-builder/pipeline-core');
  const scope = { metadata: decoded.metadata ?? {}, vars: decoded.vars ?? {} };
  const isTemplatable = (f: string) =>
    f === 'projectName' || f.startsWith('metadata.') || f.startsWith('vars.');
  const fieldToScope = (f: string) => isTemplatable(f) ? f : null;
  const result = resolveSelfReferencing(decoded, scope, isTemplatable, fieldToScope, 'pipeline');

  if (result.errors.length) {
    console.error('Resolution errors:');
    for (const e of result.errors) {
      console.error(`  [${e.field ?? '?'}] ${e.message}`);
    }
    process.exit(1);
  }
  console.log(JSON.stringify(decoded, null, 2));
}
