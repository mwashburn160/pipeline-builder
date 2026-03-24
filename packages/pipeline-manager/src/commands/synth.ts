import path from 'path';
import { Command } from 'commander';
import pico from 'picocolors';
import { auditLog } from '../utils/audit-log';
import { checkCdkAvailable, executeCdkShellCommand } from '../utils/cdk-utils';
import { printCommandHeader } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const { dim } = pico;

/**
 * Registers the `synth` command with the CLI program.
 *
 * Runs CDK synthesis using the boilerplate app. Pipeline config is resolved from:
 * - PIPELINE_PROPS env var (CLI deploy path), or
 * - PIPELINE_ID + PLATFORM_CREDENTIALS env vars (autonomous CodePipeline path)
 *
 * @example
 * ```bash
 * pipeline-manager synth
 * pipeline-manager synth --quiet --no-notices
 * pipeline-manager synth --output cdk.out --profile production
 * ```
 */
export function synth(program: Command): void {
  program
    .command('synth')
    .description('Run CDK synthesis using pipeline configuration')
    .option('--output <dir>', 'CDK output directory', 'cdk.out')
    .option('--profile <profile>', 'AWS profile')
    .option('--quiet', 'Suppress CDK output', false)
    .option('--no-notices', 'Suppress CDK notices')
    .option('--verbose', 'Show verbose CDK output', false)
    .action(async (options) => {
      const executionId = printCommandHeader('CDK Synthesis');

      try {
        auditLog('synth', { executionId, output: options.output, profile: options.profile });

        // Check CDK availability
        if (!checkCdkAvailable()) {
          printError('AWS CDK is not installed or not accessible');
          console.log(dim('Install with: npm install -g aws-cdk'));
          throw new Error('AWS CDK not found');
        }

        printSuccess('AWS CDK is available');

        // Build cdk synth command
        const boilerplatePath = path.join(__dirname, '../boilerplate.js');
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
          printKeyValue({
            'Execution ID': executionId,
            'Duration': `${result.duration}ms`,
            'Output': options.output,
            'Status': '✓ Success',
          });
        }

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          exit: true,
          context: { command: 'synth', executionId },
        });
      }
    });
}
