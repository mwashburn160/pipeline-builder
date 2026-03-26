import { Command } from 'commander';
import pico from 'picocolors';
import { ENV_VARS, assertShellSafe } from '../config/cli.constants';
import { auditLog } from '../utils/audit-log';
import { checkCdkAvailable, executeCdkShellCommand } from '../utils/cdk-utils';
import { printCommandHeader } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const { bold, cyan, dim } = pico;

/**
 * Resolves the AWS account ID from the CLI option or environment variable.
 * @returns The account ID string, or `undefined` if not available.
 */
export function resolveAccount(optionValue?: string): string | undefined {
  return optionValue || process.env.AWS_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT;
}

/**
 * Resolves the AWS region from the CLI option or environment variable.
 * @returns The region string, or `undefined` if not available.
 */
export function resolveRegion(optionValue?: string): string | undefined {
  return optionValue || process.env[ENV_VARS.AWS_REGION] || process.env.CDK_DEFAULT_REGION;
}

/**
 * Builds the `cdk bootstrap` command string from the resolved options.
 */
export function buildBootstrapCommand(options: {
  account: string;
  region: string;
  profile?: string;
  qualifier?: string;
  trust?: string;
  cloudformationExecutionPolicies?: string;
}): string {
  assertShellSafe(options.account, 'account');
  assertShellSafe(options.region, 'region');
  if (options.profile) assertShellSafe(options.profile, 'profile');

  const parts: string[] = [
    'cdk',
    'bootstrap',
    `aws://${options.account}/${options.region}`,
  ];

  if (options.profile) {
    parts.push(`--profile=${options.profile}`);
  }

  if (options.qualifier) {
    parts.push(`--qualifier=${options.qualifier}`);
  }

  if (options.trust) {
    parts.push(`--trust=${options.trust}`);
  }

  if (options.cloudformationExecutionPolicies) {
    parts.push(`--cloudformation-execution-policies=${options.cloudformationExecutionPolicies}`);
  }

  return parts.join(' ');
}

/**
 * Registers the `bootstrap` command with the CLI program.
 *
 * Provisions the CDK toolkit stack in the target AWS account/region
 * so that CDK deployments can proceed.
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function bootstrap(program: Command): void {
  program
    .command('bootstrap')
    .description('Bootstrap AWS CDK toolkit stack in target account/region')
    .option('--account <id>', 'AWS account ID (defaults to AWS_ACCOUNT_ID or CDK_DEFAULT_ACCOUNT env)')
    .option('--region <region>', 'AWS region (defaults to AWS_REGION or CDK_DEFAULT_REGION env)')
    .option('--profile <profile>', 'AWS CLI profile', 'default')
    .option('--qualifier <qualifier>', 'Bootstrap qualifier for environment isolation')
    .option('--trust <accounts>', 'Comma-separated account IDs to trust for cross-account deployments')
    .option('--cloudformation-execution-policies <arns>', 'IAM policy ARNs for CloudFormation execution role')
    .option('--json', 'Output result as JSON', false)
    .action(async (options) => {
      const executionId = printCommandHeader('CDK Bootstrap');

      try {
        auditLog('bootstrap', { executionId, account: options.account, region: options.region, profile: options.profile });

        // Resolve account and region
        const account = resolveAccount(options.account);
        const region = resolveRegion(options.region);

        if (!account) {
          printError('AWS account ID is required');
          console.log(dim('Provide --account <id> or set AWS_ACCOUNT_ID / CDK_DEFAULT_ACCOUNT environment variable'));
          throw new Error('AWS account ID not provided');
        }

        if (!region) {
          printError('AWS region is required');
          console.log(dim('Provide --region <region> or set AWS_REGION / CDK_DEFAULT_REGION environment variable'));
          throw new Error('AWS region not provided');
        }

        printInfo('Bootstrap parameters', {
          account,
          region,
          profile: options.profile,
          qualifier: options.qualifier || '(default)',
          trust: options.trust || '(none)',
          cloudformationExecutionPolicies: options.cloudformationExecutionPolicies || '(none)',
        });

        // Check CDK availability
        if (!checkCdkAvailable()) {
          printError('AWS CDK is not installed or not accessible');
          console.log(dim('Install CDK with: npm install -g aws-cdk'));
          throw new Error('AWS CDK not found');
        }

        printSuccess('AWS CDK is available');

        // Build bootstrap command
        const command = buildBootstrapCommand({
          account,
          region,
          profile: options.profile,
          qualifier: options.qualifier,
          trust: options.trust,
          cloudformationExecutionPolicies: options.cloudformationExecutionPolicies,
        });

        printSection('CDK Execution');
        console.log(cyan(bold('Command:')), dim(command));
        console.log('');

        // Execute bootstrap
        const result = executeCdkShellCommand(command, {
          debug: program.opts().debug,
          showOutput: true,
        });

        console.log('');
        printSection('Bootstrap Complete');

        if (result.success) {
          if (options.json) {
            console.log(JSON.stringify({
              success: true,
              executionId,
              account,
              region,
              duration: result.duration,
            }, null, 2));
          } else {
            printKeyValue({
              'Execution ID': executionId,
              'Account': account,
              'Region': region,
              'Duration': `${result.duration}ms`,
              'Status': '✓ Success',
            });
          }
        }

      } catch (error) {
        handleError(error, ERROR_CODES.VALIDATION, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'bootstrap',
            executionId,
            account: options.account,
            region: options.region,
          },
        });
      }
    });
}
