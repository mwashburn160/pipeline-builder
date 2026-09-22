// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '@pipeline-builder/api-core';
import { Command } from 'commander';
import ora from 'ora';
import pico from 'picocolors';
import { formatDuration, formatFileSize, FILE_SIZE_LIMITS, defaultPipelineName } from '../config/cli.constants.js';
import { type Pipeline, type PipelineResponse, type CreatePipelineRequest, type PlatformDeployConfig } from '../types/index.js';
import { printCommandHeader, printSslWarning, createAuthenticatedClient, createAuthenticatedClientAsync, withSslOptions, withProfileOption, withRegionOption } from '../utils/command-utils.js';
import { runDeploy } from '../utils/deploy-runner.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { ensureOutputDirectory, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { fetchPipelineProps } from '../utils/pipeline-config.js';
import { extractSingleResponse } from '../utils/response-utils.js';
import { relaxTlsForCli } from '../utils/tls.js';

const { bold, cyan, dim, green } = pico;

/** Parsed `pipeline create` flags. */
interface CreatePipelineOptions {
  file: string;
  project?: string;
  organization?: string;
  name?: string;
  visibility?: CreatePipelineRequest['visibility'];
  default?: boolean;
  active?: boolean;
  deploy?: boolean;
  requireApproval: string;
  output: string;
  profile?: string;
  region?: string;
  verifySsl?: boolean;
  dryRun?: boolean;
  storeTokens?: boolean;
}

/** Validate the props file (exists, size cap) and parse it as a JSON object. */
function readPropsFile(file: string): Record<string, unknown> {
  console.log('');
  printSection('File Validation');

  if (!fs.existsSync(file)) {
    printError('Properties file not found', { path: file });
    throw new ValidationError(`File not found: ${file}`, 'file');
  }

  const fileExt = path.extname(file).toLowerCase();
  if (fileExt !== '.json') {
    printWarning('File extension is not .json', { extension: fileExt });
  }

  const fileStats = fs.statSync(file);
  if (fileStats.size > FILE_SIZE_LIMITS.PIPELINE_PROPS) {
    printError('Properties file is too large', {
      size: formatFileSize(fileStats.size),
      limit: formatFileSize(FILE_SIZE_LIMITS.PIPELINE_PROPS),
    });
    throw new ValidationError('Properties file exceeds size limit', 'file');
  }

  printSuccess('File validation passed');
  printKeyValue({
    'File Path': file,
    'File Size': formatFileSize(fileStats.size),
    'Extension': fileExt,
  });

  console.log('');
  printInfo('Reading pipeline properties...');

  let props: Record<string, unknown>;
  try {
    props = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    printError('Invalid JSON in properties file', {
      error: errorMessage(error),
      hint: 'Ensure the file contains valid JSON syntax',
    });
    throw new ValidationError('Properties file must contain valid JSON', 'file');
  }

  if (typeof props !== 'object' || props === null) {
    printError('Invalid properties format', {
      type: typeof props,
      hint: 'Properties must be a JSON object',
    });
    throw new ValidationError('Properties must be a valid object', 'file');
  }

  const propCount = Object.keys(props).length;
  printSuccess('Properties parsed successfully');
  printKeyValue({
    'Total Keys': propCount.toString(),
    'Sample Keys': Object.keys(props).slice(0, 5).join(', ') + (propCount > 5 ? '...' : ''),
  });
  if (propCount === 0) {
    printWarning('Properties object is empty - pipeline will have no configuration');
  }
  return props;
}

/**
 * Build the create request. Project & organization prefer the CLI flags and
 * fall back to values embedded in the props file (builderProps).
 */
function buildCreatePayload(options: CreatePipelineOptions, props: Record<string, unknown>): CreatePipelineRequest {
  const resolvedProject = options.project ?? (props.project as string | undefined);
  const resolvedOrganization = options.organization ?? (props.organization as string | undefined);

  if (!resolvedProject) {
    printError('Project is required', {
      hint: 'Provide -p/--project flag or include "project" in the props file',
    });
    throw new ValidationError('Project is required', 'project');
  }
  if (!resolvedOrganization) {
    printError('Organization is required', {
      hint: 'Provide -o/--organization flag or include "organization" in the props file',
    });
    throw new ValidationError('Organization is required', 'organization');
  }

  // Resolve pipelineName with the shared default (mirrors pipeline-core's
  // pipeline-configuration.ts) so create + registry + CDK all agree.
  const resolvedPipelineName = options.name
    ?? (props.pipelineName as string | undefined)
    ?? defaultPipelineName(resolvedOrganization, resolvedProject);

  const payload: CreatePipelineRequest = {
    project: resolvedProject,
    organization: resolvedOrganization,
    pipelineName: resolvedPipelineName,
    props,
  };
  if (options.visibility) payload.visibility = options.visibility;
  if (options.default !== undefined) payload.isDefault = options.default;
  if (options.active !== undefined) payload.isActive = options.active;
  return payload;
}

/** Print the request that would be sent, for `--dry-run`. */
function printDryRun(options: CreatePipelineOptions, payload: CreatePipelineRequest): void {
  console.log('');
  printSection('Dry Run - Request Preview');
  console.log(JSON.stringify(payload, null, 2));
  console.log('');
  printSuccess('✓ Validation complete - no pipeline created (dry run mode)');
  console.log('');
  if (options.deploy) {
    printInfo('With --deploy, the pipeline would be deployed via CDK after creation', {
      profile: options.profile || '(default)',
      region: options.region || '(default)',
      requireApproval: options.requireApproval,
    });
  }
  printInfo('To create the pipeline, run the command without --dry-run');
}

/** Print the created pipeline and save it to `./output/pipeline-<id>.json`. */
function reportCreatedPipeline(pipeline: Pipeline, executionId: string, requestDuration: number, startTime: number): void {
  console.log('');
  printSection('✓ Pipeline Created Successfully');
  printKeyValue({
    'Pipeline ID': green(bold(pipeline.id)),
    'Project': pipeline.project,
    'Organization': pipeline.organization,
    'Name': pipeline.pipelineName || '(not set)',
    'Visibility': pipeline.visibility || 'org',
    'Default': pipeline.isDefault ? 'Yes' : 'No',
    'Active': pipeline.isActive ? 'Yes' : 'No',
    'Properties': pipeline.props ? `${Object.keys(pipeline.props).length} keys` : '(not returned)',
  });

  if (pipeline.createdAt) {
    console.log('');
    printKeyValue({ 'Created At': pipeline.createdAt });
  }

  console.log('');
  printKeyValue({
    'Execution ID': executionId,
    'Request Duration': formatDuration(requestDuration),
    'Total Duration': formatDuration(Date.now() - startTime),
  });

  const outputDir = './output';
  ensureOutputDirectory(outputDir);
  const outputFile = path.join(outputDir, `pipeline-${pipeline.id}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(pipeline, null, 2));

  console.log('');
  printSuccess('Pipeline details saved to file');
  printKeyValue({
    'Output File': outputFile,
    'File Size': formatFileSize(fs.statSync(outputFile).size),
  });
}

/**
 * `--deploy`: run the same CDK deploy + ARN registration as `pipeline deploy
 * --id`. The record already exists and is authoritative: if the deploy fails it
 * is KEPT and the exact retry is surfaced rather than rolled back (never
 * false-green).
 */
async function deployCreatedPipeline(
  options: CreatePipelineOptions,
  pipelineId: string,
  executionId: string,
  debug: boolean | undefined,
): Promise<void> {
  console.log('');
  printSection('Deploying Pipeline');
  try {
    // Deploy touches the AWS SDK + the CDK synth subprocess; relax TLS the
    // same way `deploy` does (refused in production by relaxTlsForCli).
    relaxTlsForCli(options.verifySsl, printWarning);
    // The async client adds --store-tokens (Secrets Manager) support and
    // backs BOTH the props fetch and the registry callback.
    const deployClient = await createAuthenticatedClientAsync(options);
    const deployConfig = deployClient.getConfig() as PlatformDeployConfig;
    // Re-fetch the just-created pipeline so plugins are resolved and the
    // registry host is baked EXACTLY as `deploy --id` does — no drift.
    const fetched = await fetchPipelineProps(deployClient, pipelineId);
    await runDeploy({
      pipeline: fetched.pipeline,
      propsWithIds: fetched.propsWithIds,
      profile: options.profile,
      region: options.region,
      requireApproval: options.requireApproval,
      output: options.output,
      debug,
      executionId,
      platformClient: deployClient,
      platformPipelineUrl: deployConfig.api.pipelineUrl,
      platformBaseUrl: deployConfig.api.baseUrl,
    });
  } catch (deployError) {
    printError('Pipeline was created but the deploy failed', {
      pipelineId,
      error: errorMessage(deployError),
      retry: `pipeline-manager pipeline deploy --id ${pipelineId}`,
    });
    // Re-throw so the process exits non-zero. The record is intentionally
    // retained — re-run the deploy with the command above.
    throw deployError;
  }
}

/**
 * Registers the `create-pipeline` command with the CLI program.
 *
 * Accepts a pipeline properties JSON file, validates it, resolves
 * project/organization from CLI flags or the props file, and
 * creates the pipeline via the platform API.
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function createPipeline(program: Command): void {
  withSslOptions(
    withRegionOption(
      withProfileOption(program
        .command('create')
        .description('Create a new pipeline — and optionally deploy it with --deploy')
        .requiredOption('-f, --file <file>', 'Path to pipeline properties JSON file')
        .option('-p, --project <project>', 'Project name (falls back to value in props file)')
        .option('-o, --organization <organization>', 'Organization name (falls back to value in props file)')
        .option('-n, --name <name>', 'Pipeline name')
        .option('-a, --visibility <rung>', 'Sharing rung (private|org|public). Pipelines default to org — a team asset is visible to the team.', 'org')
        .option('--default', 'Set as default pipeline', false)
        .option('--active', 'Set pipeline as active', true)
        .option('--no-active', 'Create the pipeline as inactive')
        // --deploy: after creating the record, run the same CDK deploy + ARN
        // registration as `pipeline deploy --id` (shared runDeploy). The flags
        // below apply only with --deploy.
        .option('--deploy', 'Deploy the pipeline with AWS CDK immediately after creating it', false)
        .option('--require-approval <approval>', 'Deploy approval level: never|any-change|broadening (with --deploy)', 'never')
        .option('--output <dir>', 'CDK output directory (with --deploy)', 'cdk.out')
        .option('--store-tokens', 'Deploy auth via AWS Secrets Manager token (with --deploy; requires PLATFORM_SECRET_NAME)', false)),
    ),
  )
    .option('--dry-run', 'Validate inputs without creating pipeline', false)
    .action(async (options: CreatePipelineOptions) => {
      const executionId = printCommandHeader('Create Pipeline', 'Creating Pipeline');
      const startTime = Date.now();

      try {

        // Display parameters
        printInfo('Configuration');
        printKeyValue({
          'Project': options.project || '(from props file)',
          'Organization': options.organization || '(from props file)',
          'Name': options.name || '(not set)',
          'Visibility': options.visibility,
          'Default Pipeline': options.default ? 'Yes' : 'No',
          'Active': options.active ? 'Yes' : 'No',
          'Deploy After Create': options.deploy ? `Yes (profile: ${options.profile || 'default'})` : 'No',
          'Properties File': options.file,
          'SSL Verification': options.verifySsl === false ? 'Disabled' : 'Enabled',
          'Dry Run': options.dryRun ? 'Yes' : 'No',
        });

        // Security warning for SSL verification disabled
        printSslWarning(options.verifySsl);

        const props = readPropsFile(options.file);
        const payload = buildCreatePayload(options, props);

        if (options.dryRun) {
          printDryRun(options, payload);
          return;
        }

        // Create authenticated API client
        const client = createAuthenticatedClient(options);
        const config = client.getConfig();

        // Create pipeline
        console.log('');
        printSection('Creating Pipeline');

        const spinner = ora('Creating pipeline...').start();
        let rawResponse: PipelineResponse;
        let requestDuration: number;
        try {
          const requestStart = Date.now();
          rawResponse = await client.post<PipelineResponse>(
            config.api.pipelineUrl,
            payload,
          );
          requestDuration = Date.now() - requestStart;
          spinner.succeed('Pipeline created');
        } catch (error) {
          spinner.fail('Pipeline creation failed');
          throw error;
        }

        const pipeline = extractSingleResponse<Pipeline>(rawResponse, 'pipeline', 'id');

        if (!pipeline?.id) {
          printError('Invalid pipeline response', {
            responseKeys: rawResponse ? Object.keys(rawResponse) : '(null)',
          });
          throw new Error('Pipeline creation failed - no valid pipeline data received');
        }

        reportCreatedPipeline(pipeline, executionId, requestDuration, startTime);

        if (options.deploy) {
          await deployCreatedPipeline(options, pipeline.id, executionId, program.opts().debug);
        }

        // Next steps
        console.log('');
        printSection('Next Steps');
        console.log(dim('You can now:'));
        if (!options.deploy) {
          console.log(`  ${cyan('•')} Deploy: ${bold(`deploy --id ${pipeline.id}`)}`);
        }
        console.log(`  ${cyan('•')} View: ${bold(`get-pipeline --id ${pipeline.id}`)}`);
        console.log(`  ${cyan('•')} API: ${config.api.baseUrl}${config.api.pipelineUrl}/${pipeline.id}`);
        console.log('');

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'create-pipeline',
            executionId,
            project: options.project,
            organization: options.organization,
            file: options.file,
            verifySsl: options.verifySsl,
            dryRun: options.dryRun,
          },
        });
      }
    });
}