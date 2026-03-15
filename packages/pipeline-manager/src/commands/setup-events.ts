import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const { bold, cyan, magenta } = pico;

const STACK_NAME = 'pipeline-builder-events';
const LAMBDA_NAME = 'pipeline-builder-event-ingestion';
const PACKAGE_NAME = '@mwashburn160/event-ingestion';

/**
 * Registers the `setup-events` command with the CLI program.
 *
 * Deploys EventBridge → SQS → Lambda infrastructure for pipeline reporting.
 *
 * 1. Deploys CloudFormation stack (rule + queue + Lambda shell + IAM)
 * 2. Downloads @mwashburn160/event-ingestion from npm registry
 * 3. Uploads handler code directly to Lambda (no S3 needed)
 *
 * Uses PLATFORM_BASE_URL from environment (same as all other commands).
 * Idempotent — running again updates the stack and code.
 */
export function setupEvents(program: Command): void {
  program
    .command('setup-events')
    .description('Deploy EventBridge event ingestion infrastructure for pipeline reporting')
    .option('--package-version <version>', 'event-ingestion package version (default: latest)')
    .option('--secrets-prefix <prefix>', 'Secrets Manager path prefix', 'pipeline-builder')
    .option('--region <region>', 'AWS region')
    .option('--profile <profile>', 'AWS CLI profile', 'default')
    .action(async (options) => {
      const executionId = generateExecutionId();

      try {
        printSection('Setup Event Ingestion');
        console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Execution ID'))}`);

        const region = options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION;
        if (!region) {
          printError('AWS region is required');
          throw new Error('AWS region not provided');
        }

        const platformUrl = process.env.PLATFORM_BASE_URL;
        if (!platformUrl) {
          printError('PLATFORM_BASE_URL environment variable is required');
          throw new Error('PLATFORM_BASE_URL not set');
        }

        const profileArg = options.profile ? `--profile ${options.profile}` : '';

        printInfo('Parameters', {
          stack: STACK_NAME,
          region,
          platformUrl,
          secretsPrefix: options.secretsPrefix,
          packageVersion: options.packageVersion || 'latest',
        });

        // Step 1: Deploy CloudFormation (infra only — Lambda gets placeholder code)
        printSection('Deploy Infrastructure');

        const templatePath = path.join(__dirname, '../templates/events-stack.json');

        const params = [
          `PlatformBaseUrl=${platformUrl}`,
          `SecretsPathPrefix=${options.secretsPrefix}`,
        ].join(' ');

        execSync([
          'aws cloudformation deploy',
          `--stack-name ${STACK_NAME}`,
          `--template-file ${templatePath}`,
          `--parameter-overrides ${params}`,
          '--capabilities CAPABILITY_NAMED_IAM',
          '--no-fail-on-empty-changeset',
          `--region ${region}`,
          profileArg,
        ].filter(Boolean).join(' '), { stdio: 'inherit' });

        printSuccess('Infrastructure deployed');

        // Step 2: Download handler from registry and upload to Lambda
        printSection('Deploy Lambda Code');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-ingestion-'));

        try {
          const versionSpec = options.packageVersion ? `${PACKAGE_NAME}@${options.packageVersion}` : PACKAGE_NAME;
          printInfo('Installing from registry', { package: versionSpec });

          execSync(`npm install --prefix ${tmpDir} ${versionSpec}`, { stdio: 'pipe' });

          const handlerSrc = path.join(tmpDir, 'node_modules', PACKAGE_NAME, 'lib', 'index.js');
          if (!fs.existsSync(handlerSrc)) {
            throw new Error(`Handler not found at ${handlerSrc}. Ensure the package is published.`);
          }

          // Get version from installed package
          const pkgJsonPath = path.join(tmpDir, 'node_modules', PACKAGE_NAME, 'package.json');
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
          const version = pkgJson.version || 'unknown';

          // ZIP the handler
          const zipPath = path.join(tmpDir, 'index.zip');
          execSync(`cd ${path.dirname(handlerSrc)} && zip -j ${zipPath} index.js`, { stdio: 'pipe' });

          // Upload directly to Lambda (no S3 needed)
          printInfo('Uploading code to Lambda', { function: LAMBDA_NAME, version });

          execSync(
            `aws lambda update-function-code --function-name ${LAMBDA_NAME} --zip-file fileb://${zipPath} --region ${region} ${profileArg}`,
            { stdio: 'pipe' },
          );

          printSuccess(`Lambda code deployed (${PACKAGE_NAME}@${version})`);

        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }

        // Step 3: Show outputs
        const outputsRaw = execSync(
          `aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${region} ${profileArg} --query "Stacks[0].Outputs" --output json`,
          { encoding: 'utf-8' },
        );
        const outputs = JSON.parse(outputsRaw) as Array<{ OutputKey: string; OutputValue: string }>;
        const outputMap = Object.fromEntries(outputs.map(o => [o.OutputKey, o.OutputValue]));

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
