import { createHash } from 'crypto';
import { execSync } from 'child_process';
import path from 'path';
import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import { Pipeline, PipelineResponse } from '../types';
import { ApiClient } from '../utils/api-client';
import { checkCdkAvailable, executeCdkShellCommand } from '../utils/cdk-utils';
import { getConfigWithOptions } from '../utils/config-loader';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { ensureOutputDirectory, extractSingleResponse, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';

const { bold, cyan, dim, magenta } = pico;

/**
 * Registers the `deploy` command with the CLI program.
 *
 * Fetches pipeline properties by ID from the platform API, then
 * runs `cdk synth` or `cdk deploy` to provision the pipeline
 * infrastructure in AWS.
 *
 * Requires service credentials to be pre-stored in AWS Secrets Manager.
 * Create them first with: `pipeline-manager store-credentials`
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
    .option('--synth', 'Run synthesis only (skip deployment)', false)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .action(async (options) => {
      const executionId = generateExecutionId();
      const mode = options.synth ? 'SYNTH' : 'DEPLOY';

      try {
        printSection(`Pipeline ${mode}`);

        console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Execution ID'))}`);

        printInfo('Deployment parameters', {
          id: options.id,
          mode,
          awsProfile: options.profile,
          outputDir: options.output,
          requireApproval: options.requireApproval,
          synthOnly: options.synth,
          verifySsl: options.verifySsl,
        });

        // Security warning for SSL verification disabled
        if (options.verifySsl === false) {
          printWarning('SSL certificate verification is DISABLED');
          console.log('');
        }

        // Check CDK availability
        if (!checkCdkAvailable()) {
          printError('AWS CDK is not installed or not accessible');
          console.log(dim('💡 Tip: Install CDK with: npm install -g aws-cdk'));
          throw new Error('AWS CDK not found');
        }

        printSuccess('AWS CDK is available');

        // Load configuration
        const config = getConfigWithOptions(options);

        // Fetch pipeline from API
        printInfo('Fetching pipeline configuration', { id: options.id });

        const client = new ApiClient(config);
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

        // Encode pipeline props (inject orgId for per-org secret resolution)
        const propsWithOrgId = { ...pipeline.props, ...(pipeline.orgId && { orgId: pipeline.orgId }) };
        const encoded = Buffer.from(JSON.stringify(propsWithOrgId), 'utf-8').toString('base64');
        const outputPath = options.output;

        // Ensure output directory exists
        printInfo('Preparing output directory', { path: outputPath });
        ensureOutputDirectory(outputPath);

        // Build CDK command
        const scriptPath = path.join(__dirname, '../boilerplate.js');
        const profileArg = options.profile ? `--profile=${options.profile}` : '';
        const outputArg = `--output=${outputPath}`;
        const appArg = `--app="node ${scriptPath}"`;

        const command = options.synth
          ? `cdk synth ${profileArg} ${outputArg} --notices=false ${appArg}`
          : `cdk deploy ${profileArg} --require-approval=${options.requireApproval} ${outputArg} --notices=false ${appArg}`;

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
          if (!options.synth) {
            try {
              const profileFlag = options.profile ? `--profile ${options.profile}` : '';
              const account = execSync(`aws sts get-caller-identity --query Account --output text ${profileFlag}`, { encoding: 'utf-8' }).trim();
              const region = execSync(`aws configure get region ${profileFlag}`, { encoding: 'utf-8' }).trim()
                || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';

              const pipelineName = pipeline.pipelineName
                || `${pipeline.organization}-${pipeline.project}-pipeline`.toLowerCase();

              // Hash the account number so the real value never reaches the database.
              // Must use the same SHA-256 algorithm as event-ingestion and api-core.
              const hashedAccount = createHash('sha256').update(account).digest('hex').slice(0, 12);
              const pipelineArn = `arn:aws:codepipeline:${region}:${hashedAccount}:${pipelineName}`;

              // Upsert pipeline_registry via the API
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
              // Non-blocking — deploy succeeded even if registration fails
              printWarning('Pipeline registry update failed (reporting may be incomplete)', {
                error: regError instanceof Error ? regError.message : String(regError),
              });
            }
          }
        }

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'deploy',
            executionId,
            mode,
            pipelineId: options.id,
            verifySsl: options.verifySsl,
          },
        });
      }
    });
}
