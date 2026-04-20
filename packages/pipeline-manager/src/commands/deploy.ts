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
    .description('Deploy pipeline by ID using AWS CDK')
    .requiredOption('-i, --id <id>', 'Pipeline ID')
    .option('--profile <profile>', 'AWS profile', 'default')
    .option('--require-approval <approval>', 'Approval level: never|any-change|broadening', 'never')
    .option('--output <dir>', 'CDK output directory', 'cdk.out')
    .option('--store-tokens', 'Authenticate using token from AWS Secrets Manager (requires PLATFORM_SECRET_NAME env var)', false)
    .option('--region <region>', 'AWS region (for --store-tokens)')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .action(async (options) => {

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

        // Create authenticated API client (supports PLATFORM_TOKEN or --store-tokens)
        const client = await createAuthenticatedClientAsync(options);
        const config = client.getConfig();

        // Fetch pipeline from API
        printInfo('Fetching pipeline configuration', { id: options.id });
        const response = await client.get<PipelineResponse>(
          `${config.api.pipelineUrl}/${options.id}`,
        );

        const pipeline = extractSingleResponse<Pipeline>(response, 'pipeline', 'props');

        if (!pipeline?.props) {
          printError('Invalid pipeline response', {
            id: options.id,
            hasProps: !!pipeline?.props,
            responseKeys: response ? Object.keys(response) : '(null)',
          });
          throw new Error(`Failed to retrieve valid pipeline properties for ID: ${options.id}`);
        }

        printSuccess('Pipeline configuration retrieved');
        printKeyValue({
          'ID': pipeline.id,
          'Project': pipeline.project,
          'Organization': pipeline.organization,
          'Is Default': pipeline.isDefault,
          'Is Active': pipeline.isActive,
        });

        // Encode pipeline props (inject orgId and pipelineId for autonomous synth)
        const propsWithIds = {
          ...pipeline.props,
          ...(pipeline.orgId && { orgId: pipeline.orgId }),
          pipelineId: pipeline.id,
        };

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

          // Register pipeline ARN for event reporting (non-blocking)
          try {
            const stsClient = new STSClient({ region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION });
            const identity = await stsClient.send(new GetCallerIdentityCommand({}));
            const account = identity.Account ?? '';
            const region = options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';

            const pipelineName = pipeline.pipelineName
              || `${pipeline.organization}-${pipeline.project}-pipeline`.toLowerCase();

            const hashedAccount = createHash('sha256').update(account).digest('hex').slice(0, 12);
            const pipelineArn = `arn:aws:codepipeline:${region}:${hashedAccount}:${pipelineName}`;

            await client.post(`${config.api.pipelineUrl}/registry`, {
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
