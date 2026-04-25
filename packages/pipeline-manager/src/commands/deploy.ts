// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { Command } from 'commander';
import pico from 'picocolors';
import { assertShellSafe } from '../config/cli.constants';
import { Pipeline, PipelineResponse } from '../types';
import { auditLog } from '../utils/audit-log';
import { ensureCdkAvailable, executeCdkShellCommand, resolveBoilerplatePath } from '../utils/cdk-utils';
import { printCommandHeader, printSslWarning, createAuthenticatedClientAsync } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { ensureOutputDirectory, extractSingleResponse, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';

const { bold, cyan, dim } = pico;

/**
 * Registers the `deploy` command with the CLI program.
 *
 * Fetches pipeline properties by ID from the platform API, then
 * runs `cdk deploy` to provision the pipeline infrastructure in AWS.
 * For synthesis only, use `pipeline-manager synth`.
 *
 * Requires service credentials to be pre-stored in AWS Secrets Manager.
 * Create them first with: `pipeline-manager store-token`
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function deploy(program: Command): void {
  program
    .command('deploy')
    .description('Deploy pipeline by ID using AWS CDK, or --local-spec to deploy a local pipeline.json without the platform')
    .option('-i, --id <id>', 'Pipeline ID (fetches config from the platform)')
    .option('--local-spec <path>', 'Path to a local pipeline.json — deploys without contacting the platform (no auth, no compliance, no plugin lookup)')
    .option('--profile <profile>', 'AWS profile', 'default')
    .option('--require-approval <approval>', 'Approval level: never|any-change|broadening', 'never')
    .option('--output <dir>', 'CDK output directory', 'cdk.out')
    .option('--store-tokens', 'Authenticate using token from AWS Secrets Manager (requires PLATFORM_SECRET_NAME env var)', false)
    .option('--region <region>', 'AWS region (for --store-tokens)')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--show-resolved', 'Print the resolved pipeline config (with {{ ... }} templates expanded) and exit without deploying', false)
    .action(async (options) => {
      // Mutually exclusive input sources
      if (!options.id && !options.localSpec) {
        throw new Error('Either --id <pipeline-id> or --local-spec <path> is required');
      }
      if (options.id && options.localSpec) {
        throw new Error('--id and --local-spec are mutually exclusive');
      }

      const executionId = printCommandHeader('Pipeline Deploy');

      try {
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

        // Propagate to process.env so CDK constructs (Lambda, CodeBuild) inherit it
        if (options.verifySsl === false) {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        }

        ensureCdkAvailable();
        printSuccess('AWS CDK is available');

        let pipeline: Pipeline;
        let propsWithIds: Record<string, unknown>;
        // Remote-mode registry-post handles — null in --local-spec mode.
        let platformClient: Awaited<ReturnType<typeof createAuthenticatedClientAsync>> | undefined;
        let platformConfig: { api: { pipelineUrl: string } } | undefined;

        if (options.localSpec) {
          // --local-spec: read pipeline.json from disk; no platform contact.
          // Compliance / quota / plugin-lookup features all require the platform —
          // this mode is for air-gapped or simple standalone CDK deployments.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fsMod = require('fs');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const pathMod = require('path');
          const absPath = pathMod.resolve(options.localSpec);
          printInfo('Loading local pipeline spec', { path: absPath });
          if (!fsMod.existsSync(absPath)) {
            throw new Error(`Local spec file not found: ${absPath}`);
          }
          const raw = fsMod.readFileSync(absPath, 'utf-8');
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
          // Remote path: fetch config from platform API
          platformClient = await createAuthenticatedClientAsync(options);
          platformConfig = platformClient.getConfig() as { api: { pipelineUrl: string } };

          printInfo('Fetching pipeline configuration', { id: options.id });
          const response = await platformClient.get<PipelineResponse>(
            `${platformConfig.api.pipelineUrl}/${options.id}`,
          );

          const fetched = extractSingleResponse<Pipeline>(response, 'pipeline', 'props');

          if (!fetched?.props) {
            printError('Invalid pipeline response', {
              id: options.id,
              hasProps: !!fetched?.props,
              responseKeys: response ? Object.keys(response) : '(null)',
            });
            throw new Error(`Failed to retrieve valid pipeline properties for ID: ${options.id}`);
          }
          pipeline = fetched;

          printSuccess('Pipeline configuration retrieved');
          printKeyValue({
            'ID': pipeline.id,
            'Project': pipeline.project,
            'Organization': pipeline.organization,
            'Is Default': pipeline.isDefault,
            'Is Active': pipeline.isActive,
          });

          propsWithIds = {
            ...pipeline.props,
            ...(pipeline.orgId && { orgId: pipeline.orgId }),
            pipelineId: pipeline.id,
          };
        }

        // --show-resolved: print resolved config and exit (no CDK deploy)
        if ((options as { showResolved?: boolean }).showResolved) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { resolveSelfReferencing } = require('@pipeline-builder/pipeline-core');
          const propsAny = propsWithIds as Record<string, unknown>;
          const scope = { metadata: propsAny.metadata ?? {}, vars: propsAny.vars ?? {} };
          const isTpl = (f: string) => f === 'projectName' || f.startsWith('metadata.') || f.startsWith('vars.');
          const result = resolveSelfReferencing(propsAny, scope, isTpl, (f: string) => isTpl(f) ? f : null, 'pipeline');
          if (result.errors.length) {
            console.error('Resolution errors:');
            for (const e of result.errors) console.error(`  [${e.field ?? '?'}] ${e.message}`);
            process.exit(1);
          }
          console.log(JSON.stringify(propsWithIds, null, 2));
          return;
        }

        const encoded = Buffer.from(JSON.stringify(propsWithIds), 'utf-8').toString('base64');
        const outputPath = options.output;

        // Ensure output directory exists
        printInfo('Preparing output directory', { path: outputPath });
        ensureOutputDirectory(outputPath);

        // Build CDK command (validate inputs that flow into shell)
        if (options.profile) assertShellSafe(options.profile, 'profile');
        assertShellSafe(outputPath, 'output');

        const scriptPath = resolveBoilerplatePath(__dirname);
        const profileArg = options.profile ? `--profile=${options.profile}` : '';
        const outputArg = `--output=${outputPath}`;
        const appArg = `--app="node ${scriptPath}"`;

        const command = `cdk deploy ${profileArg} --require-approval=${options.requireApproval} ${outputArg} --notices=false ${appArg}`;

        printSection('CDK Execution');
        console.log(cyan(bold('Command:')), dim(command.split(' --')[0] + ' ...'));
        console.log(''); // Empty line

        // Execute CDK command
        const result = executeCdkShellCommand(command, {
          debug: program.opts().debug,
          showOutput: true,
          env: { PIPELINE_PROPS: encoded },
        });

        console.log(''); // Empty line
        printSection('Deployment Complete');

        if (result.success) {
          printKeyValue({
            'Execution ID': executionId,
            'Duration': `${result.duration}ms`,
            'Output Directory': outputPath,
            'Status': '✓ Success',
          });

          // Register pipeline ARN for event reporting (non-blocking).
          // Skipped in --local-spec mode since there's no platform to register with.
          if (!platformClient || !platformConfig) {
            printInfo('Skipping pipeline registry (local-spec mode)');
            return;
          }
          try {
            const stsClient = new STSClient({ region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION });
            const identity = await stsClient.send(new GetCallerIdentityCommand({}));
            const account = identity.Account ?? '';
            const region = options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';

            const pipelineName = pipeline.pipelineName
              || `${pipeline.organization}-${pipeline.project}-pipeline`.toLowerCase();

            const hashedAccount = createHash('sha256').update(account).digest('hex').slice(0, 12);
            const pipelineArn = `arn:aws:codepipeline:${region}:${hashedAccount}:${pipelineName}`;

            await platformClient.post(`${platformConfig.api.pipelineUrl}/registry`, {
              pipelineId: pipeline.id,
              orgId: pipeline.orgId,
              pipelineArn,
              pipelineName,
              accountId: hashedAccount,
              region,
              project: pipeline.project,
              organization: pipeline.organization,
              stackName: `${pipeline.project}-${pipeline.organization}`.toLowerCase(),
            });

            printSuccess('Pipeline registered for event reporting', { arn: pipelineArn });
          } catch (regError) {
            printWarning('Pipeline registry update failed (reporting may be incomplete)', {
              error: regError instanceof Error ? regError.message : String(regError),
            });
          }
        }

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
