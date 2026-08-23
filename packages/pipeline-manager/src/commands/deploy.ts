// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { type Pipeline, type PlatformDeployConfig } from '../types/index.js';
import { auditLog } from '../utils/audit-log.js';
import { printCommandHeader, printSslWarning, createAuthenticatedClientAsync, withProfileOption, withRegionOption, withSslOptions } from '../utils/command-utils.js';
import { runDeploy } from '../utils/deploy-runner.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printInfo, printKeyValue, printSuccess, printWarning } from '../utils/output-utils.js';
import { fetchPipelineProps, printResolvedOrExit } from '../utils/pipeline-config.js';
import { relaxTlsForCli } from '../utils/tls.js';

/**
 * Registers the `deploy` command with the CLI program.
 *
 * Fetches pipeline properties by ID from the platform API, then
 * runs `cdk deploy` to provision the pipeline infrastructure in AWS.
 * For synthesis only, use `pipeline-manager pipeline synth`.
 *
 * Requires service credentials to be pre-stored in AWS Secrets Manager.
 * Create them first with: `pipeline-manager infra store-token`
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function deploy(program: Command): void {
  withSslOptions(
    withRegionOption(
      withProfileOption(program
        .command('deploy')
        .description('Deploy pipeline by ID using AWS CDK, or --local-spec to deploy a local pipeline.json without the platform')
        .option('-i, --id <id>', 'Pipeline ID (fetches config from the platform)')
        .option('--local-spec <path>', 'Path to a local pipeline.json — deploys without contacting the platform (no auth, no compliance, no plugin lookup)'))
        .option('--require-approval <approval>', 'Approval level: never|any-change|broadening', 'never')
        .option('--output <dir>', 'CDK output directory', 'cdk.out')
        .option('--store-tokens', 'Authenticate using token from AWS Secrets Manager (requires PLATFORM_SECRET_NAME env var)', false),
    ),
  )
    .option('--show-resolved', 'Print the resolved pipeline config (with {{ ... }} templates expanded) and exit without deploying', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Pipeline Deploy');

      try {
        // Mutually exclusive input sources — validated INSIDE the try so failures route
        // through handleError (consistent exit code/format) like every other command.
        if (!options.id && !options.localSpec) {
          throw new Error('Either --id <pipeline-id> or --local-spec <path> is required');
        }
        if (options.id && options.localSpec) {
          throw new Error('--id and --local-spec are mutually exclusive');
        }

        auditLog('deploy', { executionId, pipelineId: options.id, profile: options.profile });

        printInfo('Deployment parameters', {
          id: options.id,
          awsProfile: options.profile,
          outputDir: options.output,
          requireApproval: options.requireApproval,
          verifySsl: options.verifySsl,
        });

        // Security warning for SSL verification disabled
        printSslWarning(options.verifySsl);

        // Propagate to process.env so CDK constructs (Lambda, CodeBuild) inherit it,
        // but refuse in production (see relaxTlsForCli) — the flag disables cert
        // validation for ALL outbound TLS, including the AWS SDK.
        relaxTlsForCli(options.verifySsl, printWarning);

        // Local-tool prerequisites (cdk + esbuild/pnpm) are verified up front by
        // the CLI's preAction hook, so by here they're guaranteed present.

        let pipeline: Pipeline;
        let propsWithIds: Record<string, unknown>;
        // Remote-mode registry-post handles — null in --local-spec mode.
        let platformClient: Awaited<ReturnType<typeof createAuthenticatedClientAsync>> | undefined;
        let platformConfig: PlatformDeployConfig | undefined;

        if (options.localSpec) {
          // --local-spec: read pipeline.json from disk; no platform contact.
          // Compliance / quota / plugin-lookup features all require the platform —
          // this mode is for air-gapped or simple standalone CDK deployments.
          const absPath = path.resolve(options.localSpec);
          printInfo('Loading local pipeline spec', { path: absPath });
          if (!fs.existsSync(absPath)) {
            throw new Error(`Local spec file not found: ${absPath}`);
          }
          const raw = fs.readFileSync(absPath, 'utf-8');
          const parsed = JSON.parse(raw) as Partial<Pipeline> & { props?: Record<string, unknown> };
          if (!parsed.props) {
            throw new Error(`Local spec file is missing required 'props' field: ${absPath}`);
          }
          pipeline = {
            id: parsed.id ?? 'local',
            project: parsed.project ?? 'local-project',
            organization: parsed.organization ?? 'local-org',
            orgId: parsed.orgId,
            isDefault: parsed.isDefault ?? false,
            isActive: parsed.isActive ?? true,
            props: parsed.props,
          } as Pipeline;
          printSuccess('Local spec loaded');
          printKeyValue({
            Source: absPath,
            Project: pipeline.project,
            Organization: pipeline.organization,
          });
          propsWithIds = {
            ...pipeline.props,
            ...(pipeline.orgId && { orgId: pipeline.orgId }),
            pipelineId: pipeline.id,
          };
        } else {
          // Remote path: fetch config from platform API. fetchPipelineProps does
          // the fetch + plugin pre-resolution + registry pull-host bake — shared
          // verbatim with `synth` so the two never drift.
          platformClient = await createAuthenticatedClientAsync(options);
          platformConfig = platformClient.getConfig() as PlatformDeployConfig;

          printInfo('Fetching pipeline configuration', { id: options.id });
          const fetched = await fetchPipelineProps(platformClient, options.id);
          pipeline = fetched.pipeline;
          propsWithIds = fetched.propsWithIds;

          printSuccess('Pipeline configuration retrieved');
          printKeyValue({
            'ID': pipeline.id,
            'Project': pipeline.project,
            'Organization': pipeline.organization,
            'Is Default': pipeline.isDefault,
            'Is Active': pipeline.isActive,
          });
        }

        // --show-resolved: print resolved config and exit (no CDK deploy)
        if ((options as { showResolved?: boolean }).showResolved) {
          await printResolvedOrExit(propsWithIds);
          return;
        }

        // Steps 5–9 (encode props → cdk deploy → register ARN) are shared with
        // `pipeline create --deploy` via runDeploy so the two never drift.
        await runDeploy({
          pipeline,
          propsWithIds,
          profile: options.profile,
          region: options.region,
          requireApproval: options.requireApproval,
          output: options.output,
          debug: program.opts().debug,
          executionId,
          platformClient,
          platformPipelineUrl: platformConfig?.api.pipelineUrl,
          platformBaseUrl: platformConfig?.api.baseUrl,
        });

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'deploy',
            executionId,
            pipelineId: options.id,
            verifySsl: options.verifySsl,
          },
        });
      }
    });
}
