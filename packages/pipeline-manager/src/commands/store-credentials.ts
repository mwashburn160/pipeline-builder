import { execFileSync } from 'child_process';
import fs from 'fs';
import { Command } from 'commander';
import pico from 'picocolors';
import { auditLog } from '../utils/audit-log';
import { warnIfNotAdmin } from '../utils/auth-guard';
import { printCommandHeader } from '../utils/command-utils';
import { getToken } from '../utils/config-loader';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const { dim } = pico;

/** Default secret name following the standard {prefix}/{orgId}/{secretName} pattern. */
const DEFAULT_SECRET_NAME = 'pipeline-builder/system/credentials';

/**
 * Registers the `store-credentials` command with the CLI program.
 *
 * Creates or updates an AWS Secrets Manager secret containing the service
 * credentials used by the plugin-lookup Lambda during CDK deployments.
 *
 * Uses execFileSync (not execSync) to avoid shell interpretation of credentials.
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function storeCredentials(program: Command): void {
  program
    .command('store-credentials')
    .description('Store platform service credentials in AWS Secrets Manager for CDK deployments')
    .requiredOption('-e, --email <email>', 'Platform service account email')
    .option('-p, --password <password>', 'Platform service account password')
    .option('--password-stdin', 'Read password from stdin (avoids shell history exposure)', false)
    .option('--secret-name <name>', 'Secrets Manager secret name', DEFAULT_SECRET_NAME)
    .option('--region <region>', 'AWS region (defaults to AWS_REGION env)')
    .option('--profile <profile>', 'AWS CLI profile', 'default')
    .action(async (options) => {
      const executionId = printCommandHeader('Store Service Credentials');

      try {
        // Require admin role before executing this command
        const token = getToken();
        warnIfNotAdmin(token);

        auditLog('store-credentials', { executionId, email: options.email, secretName: options.secretName });

        // Resolve password: --password-stdin takes priority, then --password
        let password: string;
        if (options.passwordStdin) {
          password = fs.readFileSync(0, 'utf-8').trim(); // fd 0 = stdin
          if (!password) {
            throw new Error('No password received from stdin');
          }
        } else if (options.password) {
          password = options.password;
        } else {
          printError('Password is required');
          console.log(dim('Use --password <pw> or --password-stdin (recommended)'));
          throw new Error('Password not provided');
        }

        const region = options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION;
        if (!region) {
          printError('AWS region is required');
          console.log(dim('Provide --region <region> or set AWS_REGION environment variable'));
          throw new Error('AWS region not provided');
        }

        printInfo('Parameters', {
          secretName: options.secretName,
          email: options.email,
          region,
          profile: options.profile,
          passwordSource: options.passwordStdin ? 'stdin' : 'cli-arg',
        });

        const secretValue = JSON.stringify({
          email: options.email,
          password,
        });

        // Build args array — execFileSync bypasses shell, preventing credential leakage
        const baseArgs = ['--region', region];
        if (options.profile) baseArgs.push('--profile', options.profile);

        // Try to create the secret first; if it exists, update it
        try {
          execFileSync('aws', [
            'secretsmanager', 'create-secret',
            '--name', options.secretName,
            '--description', 'Service credentials for the plugin-lookup Lambda',
            '--secret-string', secretValue,
            ...baseArgs,
          ], { stdio: 'pipe' });
          printSuccess('Secret created in Secrets Manager');
        } catch (createError) {
          const errMsg = createError instanceof Error ? createError.message : '';
          if (errMsg.includes('ResourceExistsException') || errMsg.includes('already exists')) {
            printInfo('Secret already exists, updating...');
            execFileSync('aws', [
              'secretsmanager', 'put-secret-value',
              '--secret-id', options.secretName,
              '--secret-string', secretValue,
              ...baseArgs,
            ], { stdio: 'pipe' });
            printSuccess('Secret updated in Secrets Manager');
          } else {
            throw createError;
          }
        }

        // Retrieve the ARN
        const describeOutput = execFileSync('aws', [
          'secretsmanager', 'describe-secret',
          '--secret-id', options.secretName,
          '--query', 'ARN',
          '--output', 'text',
          ...baseArgs,
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

        console.log('');
        printSection('Credentials Stored');

        printKeyValue({
          'Secret Name': options.secretName,
          'Secret ARN': describeOutput,
          'Region': region,
          'Status': '✓ Stored',
        });

        console.log('');
        printSuccess('The plugin-lookup Lambda will resolve this secret by name at runtime.');
        printInfo('You can now deploy pipelines with: pipeline-manager deploy --id <id>');

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'store-credentials',
            executionId,
            secretName: options.secretName,
          },
        });
      }
    });
}
