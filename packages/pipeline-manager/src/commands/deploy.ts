/**
 * Deploy pipeline CLI command.
 *
 * Fetches a pipeline by ID from the platform API, encodes its
 * properties, and invokes AWS CDK to synthesize or deploy the
 * corresponding CloudFormation stack.
 *
 * @module commands/deploy
 */
import { execSync } from 'child_process';
import path from 'path';
import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import { Pipeline } from '../types';
import { ApiClient } from '../utils/api-client';
import { getConfig } from '../utils/config-loader';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { ensureOutputDirectory, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';

const { bold, cyan, dim, magenta } = pico;

/**
 * Checks whether the AWS CDK CLI is installed and accessible on the PATH.
 * @returns `true` if `cdk --version` succeeds, `false` otherwise.
 */
function checkCdkAvailable(): boolean {
  try {
    execSync('cdk --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Executes a CDK CLI command with the pipeline properties injected
 * as a Base64-encoded environment variable.
 *
 * @param command - The full CDK CLI command string (e.g., `cdk deploy ...`).
 * @param encodedProps - Base64-encoded JSON pipeline properties.
 * @param options - Optional execution settings.
 * @param options.debug - When `true`, prints the error to stderr on failure.
 * @param options.executionId - Correlation ID echoed back in the result.
 * @param options.showOutput - When `true`, inherits stdio so output streams to the terminal.
 * @returns An object with `success`, optional `executionId`, and `duration` in ms.
 */
function executeCdkCommand(
  command: string,
  encodedProps: string,
  options: { debug?: boolean; executionId?: string; showOutput?: boolean } = {},
): { success: boolean; executionId?: string; duration?: number } {
  const startTime = Date.now();

  try {
    const env = {
      ...process.env,
      PIPELINE_PROPS: encodedProps,
    };

    execSync(command, {
      stdio: options.showOutput ? 'inherit' : 'pipe',
      env,
    });

    const duration = Date.now() - startTime;

    return {
      success: true,
      executionId: options.executionId,
      duration,
    };
  } catch (error) {
    if (options.debug) {
      console.error('CDK execution failed:', error);
    }
    throw error;
  }
}

/**
 * Registers the `deploy` command with the CLI program.
 *
 * Fetches pipeline properties by ID from the platform API, then
 * runs `cdk synth` or `cdk deploy` to provision the pipeline
 * infrastructure in AWS.
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
        let config = getConfig();

        // Override rejectUnauthorized if --no-verify-ssl flag is provided
        if (options.verifySsl === false) {
          config = {
            ...config,
            api: {
              ...config.api,
              rejectUnauthorized: false,
            },
          };
          printWarning('Overriding config: SSL verification disabled for this request');
        }

        // Fetch pipeline from API
        printInfo('Fetching pipeline configuration', { id: options.id });

        const client = new ApiClient(config);
        const response = await client.get<any>(
          `${config.api.pipelineUrl}/${options.id}`,
        );

        // Unwrap potential response envelopes: { data: Pipeline }, { pipeline: Pipeline }, or bare Pipeline
        const pipeline: Pipeline | undefined =
          response?.props !== undefined ? response :
            response?.data?.props !== undefined ? response.data :
              response?.pipeline?.props !== undefined ? response.pipeline :
                undefined;

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
        const result = executeCdkCommand(command, encoded, {
          debug: program.opts().debug,
          executionId,
          showOutput: true,
        });

        console.log(''); // Empty line
        printSection('Deployment Complete');

        if (result.success) {
          printKeyValue({
            'Execution ID': result.executionId || executionId,
            'Duration': `${result.duration}ms`,
            'Output Directory': outputPath,
            'Status': '✓ Success',
          });
        }

      } catch (error) {
        handleError(error, ERROR_CODES.GENERAL, {
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
