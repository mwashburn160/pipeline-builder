// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as readline from 'readline';
import { Writable } from 'stream';
import { Command } from 'commander';
import { auditLog } from '../utils/audit-log';
import { upsertSecret, getSecretArn } from '../utils/aws-secrets';
import { printCommandHeader } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const DEFAULT_SECRET_NAME = 'pipeline-builder/system/registry';

/**
 * Read a password from stdin without echoing it. Falls back to plain input
 * when stdin isn't a TTY (e.g., scripted pipelines).
 */
function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Non-TTY: read a line directly (caller is responsible for not
      // leaking the password in a script — typical: `--password-stdin`).
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', (line) => { rl.close(); resolve(line); });
      rl.once('error', reject);
      return;
    }
    const muted = new Writable({
      write(_chunk, _encoding, cb) { cb(); }, // swallow output to hide typed chars
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output: muted as unknown as NodeJS.WritableStream,
      terminal: true,
    });
    process.stdout.write(prompt);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/**
 * Registers the `store-registry-credentials` command with the CLI program.
 *
 * Stores Docker registry pull credentials in AWS Secrets Manager in the
 * exact `{ "username": "...", "password": "..." }` JSON shape that
 * CodeBuild's `secretsManagerCredentials` API requires for
 * `LinuxBuildImage.fromDockerRegistry()`.
 *
 * Why this command exists alongside `store-token`:
 *   - `store-token` mints a JWT via the platform API (the platform
 *     issues; the CLI stores). Registry creds are external — pipeline-
 *     manager can't generate them, only persist them.
 *   - But the SHAPE of the secret (`{username,password}` keys at top
 *     level) is fixed by AWS. Hand-crafting JSON via `aws secretsmanager
 *     create-secret` is error-prone — a missing key or wrong nesting
 *     produces a runtime "Authentication required" failure that's hard
 *     to diagnose.
 *   - This command validates the shape, namespaces the secret under the
 *     same `pipeline-builder/system/<purpose>` convention as the platform
 *     JWT, and provides idempotent create-or-update.
 *
 * @example
 * ```bash
 * # Interactive (prompts for password without echo):
 * pipeline-manager store-registry-credentials --username gh-bot
 *
 * # Scripted (read password from stdin):
 * echo "$REGISTRY_TOKEN" | pipeline-manager store-registry-credentials \
 *   --username gh-bot --password-stdin
 *
 * # Custom secret name (e.g., per-org registry):
 * pipeline-manager store-registry-credentials \
 *   --secret-name acmecorp/ci/docker-registry \
 *   --username gh-bot
 * ```
 */
export function storeRegistryCredentials(program: Command): void {
  program
    .command('store-registry-credentials')
    .alias('store-registry')
    .description('Store Docker registry pull credentials in AWS Secrets Manager (used by CodeBuild to pull plugin images)')
    .option('-u, --username <username>', 'Registry username (e.g., GitHub username for ghcr.io)')
    .option('-p, --password <password>', 'Registry password/token (NOT recommended — appears in shell history; use --password-stdin instead)')
    .option('--password-stdin', 'Read the password from stdin (one line)', false)
    .option('--secret-name <name>', `Secrets Manager secret name (default: ${DEFAULT_SECRET_NAME})`)
    .option('--region <region>', 'AWS region (defaults to AWS_REGION env)')
    .option('--profile <profile>', 'AWS CLI profile', 'default')
    .option('--dry-run', 'Show what would be stored without writing to Secrets Manager', false)
    .option('--json', 'Output result as JSON', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Store Registry Credentials');

      try {
        const region = options.region
          || process.env.AWS_REGION
          || process.env.CDK_DEFAULT_REGION
          || 'us-east-1';

        const secretName = options.secretName
          || process.env.IMAGE_REGISTRY_CREDS_SECRET
          || DEFAULT_SECRET_NAME;

        if (!options.username) {
          throw new Error('--username is required (use the GitHub username for ghcr.io, the registry user for self-hosted, etc.)');
        }

        // Resolve the password: explicit flag → stdin → interactive prompt.
        let password: string;
        if (options.password) {
          password = options.password;
        } else if (options.passwordStdin) {
          password = await promptPassword(''); // non-TTY path reads a line
        } else {
          password = await promptPassword('Registry password/token: ');
        }
        if (!password) {
          throw new Error('Password is required (provide via --password, --password-stdin, or interactive prompt)');
        }

        printSection('Parameters');
        printKeyValue({
          'Secret Name': secretName,
          'Region': region,
          'Username': options.username,
          'Password': '***' + ' (' + password.length + ' chars)',
          'Dry Run': options.dryRun ? 'yes' : 'no',
        });

        auditLog('store-registry-credentials', {
          executionId,
          secretName,
          username: options.username,
          dryRun: options.dryRun,
        });

        // CodeBuild's `secretsManagerCredentials` requires this exact shape.
        // Anything else and image-pull silently fails with "Authentication
        // required" at the IMAGE_PULL phase.
        const secretValue = JSON.stringify({
          username: options.username,
          password,
        });

        if (options.dryRun) {
          if (options.json) {
            console.log(JSON.stringify({
              success: true,
              dryRun: true,
              secretName,
              region,
              schema: '{username, password}',
              passwordLength: password.length,
            }, null, 2));
          } else {
            console.log('');
            printSection('Dry Run — No Changes Made');
            printSuccess(`Would create/update secret: ${secretName}`);
          }
          return;
        }

        printSection('Store Credentials');
        const description = 'Docker registry pull credentials for CodeBuild plugin image pulls';
        await upsertSecret(secretName, secretValue, description, { region, profile: options.profile });

        const arn = await getSecretArn(secretName, { region, profile: options.profile });

        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            secretName,
            secretArn: arn,
            region,
            schema: '{username, password}',
          }, null, 2));
        } else {
          console.log('');
          printSection('Credentials Stored');
          printKeyValue({
            'Secret Name': secretName,
            'Secret ARN': arn,
            'Region': region,
            'Status': '✓ Stored',
          });

          console.log('');
          printSuccess('Registry credentials stored. They will be used by CodeBuild to pull plugin images.');
          printInfo('To override the secret name in pipeline-core, set:');
          printInfo(`  export IMAGE_REGISTRY_CREDS_SECRET=${secretName}`);
          console.log('');
          printInfo('Rotate these credentials by re-running this command — the secret is upserted in place.');
        }
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'store-registry-credentials',
            executionId,
            secretName: options.secretName || DEFAULT_SECRET_NAME,
          },
        });
      }
    });
}
