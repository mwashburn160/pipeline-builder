import { execSync } from 'child_process';
import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const { bold, cyan, dim, magenta } = pico;

/** Default secret name used by the plugin-lookup Lambda. */
const DEFAULT_SECRET_NAME = 'pipeline-builder/plugin-lookup/credentials';

/**
 * Registers the `store-credentials` command with the CLI program.
 *
 * Creates or updates an AWS Secrets Manager secret containing the service
 * credentials used by the plugin-lookup Lambda during CDK deployments.
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function storeCredentials(program: Command): void {
  program
    .command('store-credentials')
    .description('Store platform service credentials in AWS Secrets Manager for CDK deployments')
    .requiredOption('-e, --email <email>', 'Platform service account email')
    .requiredOption('-p, --password <password>', 'Platform service account password')
    .option('--secret-name <name>', 'Secrets Manager secret name', DEFAULT_SECRET_NAME)
    .option('--region <region>', 'AWS region (defaults to AWS_REGION env)')
    .option('--profile <profile>', 'AWS CLI profile', 'default')
    .action(async (options) => {
      const executionId = generateExecutionId();

      try {
        printSection('Store Service Credentials');

        console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Execution ID'))}`);

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
        });

        const secretValue = JSON.stringify({
          email: options.email,
          password: options.password,
        });

        const profileArg = options.profile ? `--profile ${options.profile}` : '';
        const regionArg = `--region ${region}`;

        // Try to create the secret first; if it exists, update it
        try {
          execSync(
            'aws secretsmanager create-secret ' +
            `--name "${options.secretName}" ` +
            '--description "Service credentials for the plugin-lookup Lambda" ' +
            `--secret-string '${secretValue.replace(/'/g, "'\\''")}' ` +
            `${regionArg} ${profileArg}`,
            { stdio: 'pipe' },
          );
          printSuccess('Secret created in Secrets Manager');
        } catch (createError) {
          // Secret already exists — update it
          const errMsg = createError instanceof Error ? createError.message : '';
          if (errMsg.includes('ResourceExistsException') || errMsg.includes('already exists')) {
            printInfo('Secret already exists, updating...');
            execSync(
              'aws secretsmanager put-secret-value ' +
              `--secret-id "${options.secretName}" ` +
              `--secret-string '${secretValue.replace(/'/g, "'\\''")}' ` +
              `${regionArg} ${profileArg}`,
              { stdio: 'pipe' },
            );
            printSuccess('Secret updated in Secrets Manager');
          } else {
            throw createError;
          }
        }

        // Retrieve the ARN
        const describeOutput = execSync(
          'aws secretsmanager describe-secret ' +
          `--secret-id "${options.secretName}" ` +
          `${regionArg} ${profileArg} ` +
          '--query ARN --output text',
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();

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
