// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import * as os from 'os';
import path from 'path';
import { LambdaClient, UpdateFunctionCodeCommand } from '@aws-sdk/client-lambda';
import { Command } from 'commander';
import { validateNumber } from '../config/cli.constants.js';
import { auditLog } from '../utils/audit-log.js';
import { decodeTokenPayload } from '../utils/auth-guard.js';
import { upsertSecret, getSecretArn } from '../utils/aws-secrets.js';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning } from '../utils/command-utils.js';
import { toEventBridgeCron } from '../utils/cron.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils.js';
import { ensurePlatformToken, resolveSecretName } from '../utils/platform-secret.js';

// ESM has no __dirname; derive it from this module's URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RENEW_STACK_NAME = 'pipeline-builder-token-renew';
// CFN-managed Lambda function name — keep in sync with token-renew-stack.json.
const RENEW_LAMBDA_NAME = 'pipeline-builder-token-renew';
// Default 5-field cron (daily at midnight) when neither --cron nor TOKEN_RENEW_SCHEDULE is set.
const DEFAULT_RENEW_CRON = '0 0 * * *';

/**
 * Deploy (or update) the once-a-day token-renewal stack: a scheduled Lambda that
 * re-mints the platform JWT in this same secret before it expires. Mirrors
 * setup-events — `aws cloudformation deploy` for the infra, then a direct
 * UpdateFunctionCode with the self-contained handler compiled alongside this CLI.
 */
async function deployRenewSchedule(opts: {
  platformUrl: string;
  secretName: string;
  days: number;
  fiveFieldCron: string;
  region: string;
  profile?: string;
}): Promise<string> {
  const scheduleExpression = toEventBridgeCron(opts.fiveFieldCron); // validates + 15-min guard

  printSection('Schedule Renewal');
  printInfo('Parameters', {
    stack: RENEW_STACK_NAME,
    schedule: opts.fiveFieldCron,
    eventbridge: scheduleExpression,
    renewDays: opts.days,
  });

  // Step 1: infra (Lambda gets placeholder code on first create).
  const templatePath = path.join(__dirname, '../templates/token-renew-stack.json');
  const cfnArgs = [
    'cloudformation', 'deploy',
    '--stack-name', RENEW_STACK_NAME,
    '--template-file', templatePath,
    '--parameter-overrides',
    `PlatformBaseUrl=${opts.platformUrl}`,
    `PlatformSecretName=${opts.secretName}`,
    `RenewDays=${opts.days}`,
    `ScheduleExpression=${scheduleExpression}`,
    '--capabilities', 'CAPABILITY_NAMED_IAM',
    '--no-fail-on-empty-changeset',
    '--region', opts.region,
  ];
  if (opts.profile) cfnArgs.push('--profile', opts.profile);
  execFileSync('aws', cfnArgs, { stdio: 'inherit' });

  // Step 2: upload the real handler. It's ESM, so the zip entry must be index.mjs
  // (Handler stays index.handler — nodejs24.x resolves the .mjs extension).
  const handlerSrc = path.join(__dirname, '../lambda/token-renew-handler.js');
  if (!fs.existsSync(handlerSrc)) {
    throw new Error(`Token-renew handler not found at ${handlerSrc} — was the package built?`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-renew-'));
  try {
    fs.copyFileSync(handlerSrc, path.join(tmpDir, 'index.mjs'));
    const zipPath = path.join(tmpDir, 'index.zip');
    execFileSync('zip', ['-j', zipPath, 'index.mjs'], { cwd: tmpDir, stdio: 'pipe' });

    const lambdaClient = new LambdaClient({ region: opts.region });
    await lambdaClient.send(new UpdateFunctionCodeCommand({
      FunctionName: RENEW_LAMBDA_NAME,
      ZipFile: fs.readFileSync(zipPath),
    }));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  printSuccess(`Renewal scheduled (${scheduleExpression})`);
  return scheduleExpression;
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
    .option('--cron <expr>', 'Renewal schedule as a 5-field cron (default: TOKEN_RENEW_SCHEDULE env or "0 0 * * *"; min every 15 minutes)')
    .option('--no-schedule', 'Skip deploying the daily token-renewal stack (it is installed by default)')
    .option('--json', 'Output result as JSON', false)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .action(async (options) => {
      const executionId = printCommandHeader('Store Token');

      try {
        printSslWarning(options.verifySsl);

        const region = options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';

        const days = validateNumber(options.days, 'days', 1, 365);
        const expiresInSeconds = days * 24 * 60 * 60;

        // Step 0: log in first when creds are available and no PLATFORM_TOKEN is set
        // (shared with setup-events). Creds come from --email/--password OR the env
        // vars PLATFORM_IDENTIFIER/PLATFORM_PASSWORD — the env path lets callers like
        // `provision --with-events` pass them without putting the password on the
        // command line (where it would show in plans/logs).
        await ensurePlatformToken(options);

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

        const tokenData = (tokenResponse as Record<string, unknown>)?.data ?? tokenResponse;
        const accessToken = (tokenData as Record<string, unknown>)?.accessToken as string | undefined;
        const refreshToken = (tokenData as Record<string, unknown>)?.refreshToken as string | undefined;
        const actualExpiresIn = ((tokenData as Record<string, unknown>)?.expiresIn as number) ?? expiresInSeconds;

        if (!accessToken) {
          throw new Error('Token generation failed — no access token in response');
        }

        printSuccess(`Token generated (expires in ${actualExpiresIn}s)`);

        const expiresAt = new Date(Date.now() + actualExpiresIn * 1000).toISOString();

        // Schema: { username: orgId, password: JWT, ...metadata }
        // - username/password fields satisfy CodeBuild's `secretsManagerCredentials`
        //   (HTTP Basic, sent to pipeline-image-registry's /token endpoint)
        // - The same JWT is consumed by the plugin-lookup Lambda by reading
        //   the `password` field
        // - One Secret per customer account replaces the previous two-secret model
        // Decode JWT for orgId — it's a stable identifier for the username field;
        // the actual auth uses the password (JWT) which the token service verifies.
        // `||` (not `??`): an EMPTY-string organizationId must also fall back. A
        // sysadmin/system token often carries organizationId="", and CodeBuild
        // rejects a registry credential whose `username` field is empty with
        // "AuthorizationData is malformed, empty field" — so username must always
        // be a non-empty value.
        const payload = decodeTokenPayload(accessToken);
        const orgId = payload?.organizationId?.trim() || 'unknown-org';

        const secretValue = JSON.stringify({
          username: orgId,
          password: accessToken,
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

        // Install the once-a-day renewal stack so this token never lapses (default
        // on; opt out with --no-schedule). commander sets options.schedule=false for
        // --no-schedule, true otherwise.
        let scheduleExpression: string | undefined;
        if (options.schedule !== false) {
          const fiveFieldCron = options.cron || process.env.TOKEN_RENEW_SCHEDULE || DEFAULT_RENEW_CRON;
          scheduleExpression = await deployRenewSchedule({
            platformUrl: client.getBaseUrl(),
            secretName,
            days,
            fiveFieldCron,
            region,
            profile: options.profile,
          });
        }

        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            secretName,
            secretArn: arn,
            region,
            expiresInDays: days,
            expiresAt,
            schedule: scheduleExpression ?? null,
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
            'Auto-Renew': scheduleExpression ? `✓ ${scheduleExpression}` : 'disabled (--no-schedule)',
            'Status': '✓ Stored',
          });

          console.log('');
          printSuccess('Token stored. To use with synth/deploy:');
          printInfo(`  export PLATFORM_SECRET_NAME=${secretName}`);
          printInfo('  pipeline-manager synth --id <pipeline-id> --store-tokens');
          console.log('');
          if (scheduleExpression) {
            printInfo(`Auto-renewal is active (${scheduleExpression}); the secret refreshes before ${expiresAt}.`);
          } else {
            printInfo(`Renew before ${expiresAt} with: pipeline-manager store-token --days ${days}`);
          }
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
