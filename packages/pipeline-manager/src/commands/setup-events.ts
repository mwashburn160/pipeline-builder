// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import * as os from 'os';
import path from 'path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { LambdaClient, UpdateFunctionCodeCommand } from '@aws-sdk/client-lambda';
import { Command } from 'commander';
import { printCommandHeader } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils.js';
import { resolvePlatformSecretName } from '../utils/platform-secret.js';

// ESM has no __dirname; derive it from this module's URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STACK_NAME = 'pipeline-builder-events';
// Existing CFN-managed Lambda function name — do NOT rename without a migration plan
const LAMBDA_NAME = 'pipeline-builder-event-ingestion';
const PACKAGE_NAME = '@pipeline-builder/pipeline-events';

/**
 * Registers the `setup-events` command with the CLI program.
 *
 * Deploys EventBridge → SQS → Lambda infrastructure for pipeline reporting.
 *
 * 1. Deploys CloudFormation stack (rule + queue + Lambda shell + IAM)
 * 2. Downloads @pipeline-builder/pipeline-events from npm registry
 * 3. Uploads handler code directly to Lambda (no S3 needed)
 *
 * Uses PLATFORM_BASE_URL from environment (same as all other commands).
 * Idempotent — running again updates the stack and code.
 */
export function setupEvents(program: Command): void {
  program
    .command('setup-events')
    .description('Deploy EventBridge event ingestion infrastructure for pipeline reporting')
    .option('--package-version <version>', 'pipeline-events package version (default: latest)')
    .option('-e, --email <email>', 'Login email to mint a token when PLATFORM_TOKEN is unset (for deriving the secret name)')
    .option('-p, --password <password>', 'Login password (used with --email)')
    .option('--region <region>', 'AWS region (default: us-east-1, or AWS_REGION env)')
    .option('--profile <profile>', 'AWS CLI profile', 'default')
    .action(async (options) => {
      const executionId = printCommandHeader('Setup Event Ingestion');

      try {
        const region = options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';

        const platformUrl = process.env.PLATFORM_BASE_URL;
        if (!platformUrl) {
          printError('PLATFORM_BASE_URL environment variable is required');
          throw new Error('PLATFORM_BASE_URL not set');
        }

        // Derive the secret path from the platform token (the one init-platform.sh
        // minted) when PLATFORM_SECRET_NAME isn't set — matching store-token, which
        // WROTE the secret at the same derived path. Logs in with
        // --email/--password or PLATFORM_IDENTIFIER/PLATFORM_PASSWORD if no token yet.
        const secretName = await resolvePlatformSecretName(options);

        printInfo('Parameters', {
          stack: STACK_NAME,
          region,
          platformUrl,
          secretName,
          packageVersion: options.packageVersion || 'latest',
        });

        // Step 1: Deploy CloudFormation (infra only — Lambda gets placeholder code)
        printSection('Deploy Infrastructure');

        const templatePath = path.join(__dirname, '../templates/events-stack.json');

        const cfnArgs = [
          'cloudformation', 'deploy',
          '--stack-name', STACK_NAME,
          '--template-file', templatePath,
          '--parameter-overrides',
          `PlatformBaseUrl=${platformUrl}`,
          `PlatformSecretName=${secretName}`,
          '--capabilities', 'CAPABILITY_NAMED_IAM',
          '--no-fail-on-empty-changeset',
          '--region', region,
        ];
        if (options.profile) cfnArgs.push('--profile', options.profile);

        execFileSync('aws', cfnArgs, { stdio: 'inherit' });

        printSuccess('Infrastructure deployed');

        // Step 2: Download handler from registry and upload to Lambda
        printSection('Deploy Lambda Code');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-ingestion-'));

        try {
          const versionSpec = options.packageVersion ? `${PACKAGE_NAME}@${options.packageVersion}` : PACKAGE_NAME;
          printInfo('Installing from registry', { package: versionSpec });

          // Isolate the npm cache inside the temp dir so the deploy never depends on
          // (or trips over) a misconfigured shared ~/.npm cache — e.g. EACCES/EEXIST
          // left behind by a prior `sudo npm` run. Mirrors the token-renew handler.
          execFileSync('npm', ['install', '--prefix', tmpDir, '--no-audit', '--no-fund', versionSpec], {
            stdio: 'pipe',
            env: { ...process.env, npm_config_cache: path.join(tmpDir, '.npm-cache') },
          });

          const handlerSrc = path.join(tmpDir, 'node_modules', PACKAGE_NAME, 'lib', 'index.js');
          if (!fs.existsSync(handlerSrc)) {
            throw new Error(`Handler not found at ${handlerSrc}. Ensure the package is published.`);
          }

          // Get version from installed package
          const pkgJsonPath = path.join(tmpDir, 'node_modules', PACKAGE_NAME, 'package.json');
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
          const version = pkgJson.version || 'unknown';

          // pipeline-events is ESM ("type":"module"), so the Lambda entry must be
          // index.mjs. A plain index.js with no package.json in the zip is loaded as
          // CommonJS by nodejs24.x and fails at init with "Cannot use import statement
          // outside a module". The .mjs extension forces ESM; Handler stays
          // index.handler (the runtime resolves the .mjs file). lib/index.js is a
          // self-contained bundle (no relative imports), so the single file suffices.
          const mjsPath = path.join(tmpDir, 'index.mjs');
          fs.copyFileSync(handlerSrc, mjsPath);
          const zipPath = path.join(tmpDir, 'index.zip');
          execFileSync('zip', ['-j', zipPath, 'index.mjs'], { cwd: tmpDir, stdio: 'pipe' });

          // Upload directly to Lambda via SDK (no S3 needed)
          printInfo('Uploading code to Lambda', { function: LAMBDA_NAME, version });

          const lambdaClient = new LambdaClient({ region });
          await lambdaClient.send(new UpdateFunctionCodeCommand({
            FunctionName: LAMBDA_NAME,
            ZipFile: fs.readFileSync(zipPath),
          }));

          printSuccess(`Lambda code deployed (${PACKAGE_NAME}@${version})`);

        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }

        // Step 3: Show outputs via SDK
        const cfnClient = new CloudFormationClient({ region });
        const describeResult = await cfnClient.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
        const outputs = describeResult.Stacks?.[0]?.Outputs ?? [];
        const outputMap = Object.fromEntries(outputs.map(o => [o.OutputKey ?? '', o.OutputValue ?? '']));

        console.log('');
        printSection('Event Ingestion Ready');

        printKeyValue({
          'Stack': STACK_NAME,
          'Region': region,
          'Platform URL': platformUrl,
          'Lambda': outputMap.LambdaFunctionArn || LAMBDA_NAME,
          'Event Queue': outputMap.EventQueueUrl || '(see AWS console)',
          'Dead Letter Queue': outputMap.DeadLetterQueueUrl || '(see AWS console)',
          'EventBridge Rule': outputMap.EventRuleName || '(see AWS console)',
          'Status': '✓ Deployed',
        });

        console.log('');
        printSuccess('EventBridge event ingestion is active.');

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'setup-events', executionId, stack: STACK_NAME },
        });
      }
    });
}
