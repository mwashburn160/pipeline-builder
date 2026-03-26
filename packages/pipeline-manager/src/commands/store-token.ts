import { CoreConstants } from '@mwashburn160/pipeline-core';
import axios from 'axios';
import { Command } from 'commander';
import pico from 'picocolors';
import { validateNumber } from '../config/cli.constants';
import { auditLog } from '../utils/audit-log';
import { decodeTokenPayload } from '../utils/auth-guard';
import { upsertSecret, getSecretArn } from '../utils/aws-secrets';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning } from '../utils/command-utils';
import { getConfigWithOptions } from '../utils/config-loader';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const { dim } = pico;

/**
 * Build the secret name from the JWT token's organizationId.
 * Pattern: {SECRETS_PATH_PREFIX}/{orgId}/platform
 * @throws Error if organizationId is not present in the token
 */
function resolveSecretName(token: string): string {
  const payload = decodeTokenPayload(token);
  const orgId = payload?.organizationId;
  if (!orgId) {
    throw new Error('Token does not contain organizationId — cannot derive secret name. Use --secret-name to specify explicitly.');
  }
  return `${CoreConstants.SECRETS_PATH_PREFIX}/${orgId}/platform`;
}

/**
 * Registers the `store-token` command with the CLI program.
 *
 * Generates a long-lived JWT token via the platform API and stores it
 * in AWS Secrets Manager for use by the synth/deploy --store-tokens flag.
 *
 * Requires PLATFORM_TOKEN to be set, or use --email/--password to login inline.
 *
 * @example
 * ```bash
 * pipeline-manager store-token --region us-east-1
 * pipeline-manager store-token --days 90 --region us-east-1
 * pipeline-manager store-token --days 7 --secret-name my-custom-secret --no-verify-ssl
 * pipeline-manager store-token --dry-run
 * pipeline-manager store-token -e admin -p '***' --region us-east-1
 * ```
 */
export function storeToken(program: Command): void {
  program
    .command('store-token')
    .description('Generate JWT token and store in AWS Secrets Manager for CDK deployments')
    .option('-e, --email <email>', 'Login email (skips PLATFORM_TOKEN requirement)')
    .option('-p, --password <password>', 'Login password (used with --email)')
    .option('--days <days>', 'Token lifetime in days', '30')
    .option('--dry-run', 'Show what would be stored without writing to Secrets Manager', false)
    .option('--secret-name <name>', 'Secrets Manager secret name (default: derived from token org)')
    .option('--region <region>', 'AWS region (defaults to AWS_REGION env)')
    .option('--profile <profile>', 'AWS CLI profile', 'default')
    .option('--json', 'Output result as JSON', false)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .action(async (options) => {
      const executionId = printCommandHeader('Store Token');

      try {
        printSslWarning(options.verifySsl);

        const region = options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION;
        if (!region) {
          printError('AWS region is required');
          console.log(dim('Provide --region <region> or set AWS_REGION environment variable'));
          throw new Error('AWS region not provided');
        }

        const days = validateNumber(options.days, 'days', 1, 365);
        const expiresInSeconds = days * 24 * 60 * 60;

        // Step 0: If --email/--password provided and no PLATFORM_TOKEN, login first
        if (options.email && options.password && !process.env.PLATFORM_TOKEN) {
          printSection('Login');
          printInfo('Authenticating with email/password...');

          const config = getConfigWithOptions(options);
          const loginUrl = `${config.api.baseUrl}/api/auth/login`;

          const loginResponse = await axios.post(loginUrl, {
            email: options.email,
            password: options.password,
          }, {
            httpsAgent: config.api.rejectUnauthorized === false
              ? new (await import('https')).Agent({ rejectUnauthorized: false })
              : undefined,
          });

          const loginData = loginResponse.data as Record<string, unknown>;
          const loginToken = (loginData.data as Record<string, unknown> | undefined)?.accessToken
            ?? loginData.accessToken;

          if (!loginToken || typeof loginToken !== 'string') {
            throw new Error('Login failed — no access token in response');
          }

          process.env.PLATFORM_TOKEN = loginToken;
          printSuccess('Login successful');
        }

        // Step 1: Authenticate and generate long-lived token
        printSection('Generate Token');

        const client = await createAuthenticatedClientAsync(options);

        // Resolve secret name from token's organizationId (unless --secret-name was explicitly set)
        const secretName = options.secretName || resolveSecretName(process.env.PLATFORM_TOKEN!);

        auditLog('store-token', { executionId, secretName, days: options.days, dryRun: options.dryRun });

        printInfo('Parameters', {
          secretName,
          region,
          days,
          expiresIn: `${expiresInSeconds}s`,
          dryRun: options.dryRun,
        });

        printInfo('Requesting token', { expiresIn: `${expiresInSeconds}s (${days} days)` });

        const tokenResponse = await client.post<Record<string, unknown>>(
          '/api/user/generate-token',
          { expiresIn: expiresInSeconds },
        );

        const data = (tokenResponse as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
        const accessToken = (data?.accessToken || (tokenResponse as Record<string, unknown>)?.accessToken) as string | undefined;
        const refreshToken = (data?.refreshToken || (tokenResponse as Record<string, unknown>)?.refreshToken) as string | undefined;
        const actualExpiresIn = ((data?.expiresIn || (tokenResponse as Record<string, unknown>)?.expiresIn) as number) ?? expiresInSeconds;

        if (!accessToken) {
          throw new Error('Token generation failed — no access token in response');
        }

        printSuccess(`Token generated (expires in ${actualExpiresIn}s)`);

        const expiresAt = new Date(Date.now() + actualExpiresIn * 1000).toISOString();

        const secretValue = JSON.stringify({
          accessToken,
          ...(refreshToken && { refreshToken }),
          platformUrl: client.getBaseUrl(),
          expiresIn: actualExpiresIn,
          expiresAt,
          createdAt: new Date().toISOString(),
        });

        // Dry-run: show what would be stored
        if (options.dryRun) {
          if (options.json) {
            console.log(JSON.stringify({
              success: true,
              dryRun: true,
              secretName,
              region,
              expiresInDays: days,
              expiresAt,
              tokenLength: accessToken.length,
              hasRefreshToken: !!refreshToken,
            }, null, 2));
          } else {
            console.log('');
            printSection('Dry Run — No Changes Made');
            printKeyValue({
              'Secret Name': secretName,
              'Region': region,
              'Expires In': `${days} days`,
              'Renew By': expiresAt,
              'Token Length': `${accessToken.length} chars`,
              'Has Refresh Token': refreshToken ? 'Yes' : 'No',
            });
            printSuccess('Dry run complete — no secret was created or updated');
          }
          return;
        }

        // Step 2: Store token in Secrets Manager
        printSection('Store Token');

        const description = `Platform JWT token (renew by ${expiresAt})`;
        await upsertSecret(secretName, secretValue, description, { region, profile: options.profile });

        const arn = await getSecretArn(secretName, { region, profile: options.profile });

        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            secretName,
            secretArn: arn,
            region,
            expiresInDays: days,
            expiresAt,
          }, null, 2));
        } else {
          console.log('');
          printSection('Token Stored');

          printKeyValue({
            'Secret Name': secretName,
            'Secret ARN': arn,
            'Region': region,
            'Expires In': `${days} days`,
            'Renew By': expiresAt,
            'Status': '✓ Stored',
          });

          console.log('');
          printSuccess('Token stored. To use with synth/deploy:');
          printInfo(`  export PLATFORM_SECRET_NAME=${secretName}`);
          printInfo('  pipeline-manager synth --id <pipeline-id> --store-tokens');
          console.log('');
          printInfo(`Renew before ${expiresAt} with: pipeline-manager store-token --days ${days}`);
        }

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'store-token',
            executionId,
            secretName: options.secretName || '(derived from token)',
          },
        });
      }
    });
}
