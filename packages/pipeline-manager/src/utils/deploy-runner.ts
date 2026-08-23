// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pico from 'picocolors';
import { executeCdkShellCommand, resolveBoilerplatePath } from './cdk-utils.js';
import { ensureOutputDirectory, printInfo, printKeyValue, printSection, printSuccess, printWarning } from './output-utils.js';
import { buildRegistryPayload, writePendingIntent } from './registry.js';
import { assertShellSafe, shellQuote } from '../config/cli.constants.js';
import { type Pipeline } from '../types/index.js';

const { bold, cyan, dim } = pico;

// ESM has no __dirname; derive it from this module's URL. `resolveBoilerplatePath`
// returns `../boilerplate.js`, which is the same target whether resolved from
// src/commands or src/utils (both are siblings under src/), so this stays correct.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Minimal platform client shape needed to register a deployed ARN. */
interface RegistryClient {
  post: (url: string, body: unknown) => Promise<unknown>;
}

/** Inputs for {@link runDeploy} — an already-resolved pipeline + props. */
export interface RunDeployInput {
  /** The pipeline being deployed (id/orgId/name/project/org drive registration). */
  pipeline: Pick<Pipeline, 'id' | 'orgId' | 'pipelineName' | 'project' | 'organization'>;
  /** Fully-resolved props (plugins pre-resolved, registry host baked, ids included). */
  propsWithIds: Record<string, unknown>;
  /** AWS profile / region for the deploy + registry payload. */
  profile?: string;
  region?: string;
  /** `cdk deploy --require-approval` level and `--output` dir. */
  requireApproval: string;
  output: string;
  debug?: boolean;
  /** For the command header / summary line. */
  executionId: string;
  /** Registry callback — omit (e.g. --local-spec) to skip ARN registration. */
  platformClient?: RegistryClient;
  platformPipelineUrl?: string;
  platformBaseUrl?: string;
}

/**
 * Run `cdk deploy` for an already-resolved pipeline, then register the deployed
 * ARN for event reporting (best-effort). Shared by `pipeline deploy` and
 * `pipeline create --deploy` so the two entry points never drift.
 *
 * THROWS on CDK failure (the caller maps it to a non-zero exit and, for the
 * create path, keeps the created record and prints the `deploy --id` retry).
 * Registry failures are NON-fatal — they're queued to a pending-intent file for
 * `pipeline register` to drain later.
 */
export async function runDeploy(input: RunDeployInput): Promise<void> {
  const { pipeline, propsWithIds, profile, region, requireApproval, output, debug, executionId } = input;

  const encoded = Buffer.from(JSON.stringify(propsWithIds), 'utf-8').toString('base64');

  printInfo('Preparing output directory', { path: output });
  ensureOutputDirectory(output);

  // Validate EVERY input that flows into the shell (interpolated unquoted below).
  if (profile) assertShellSafe(profile, 'profile');
  assertShellSafe(output, 'output');
  assertShellSafe(requireApproval, 'require-approval');

  // `assertShellSafe` rejects shell metacharacters but ALLOWS spaces, so quote
  // every interpolated value (a path/profile with a space would otherwise split
  // into extra cdk args — matching how the agent path quotes them).
  const scriptPath = resolveBoilerplatePath(__dirname);
  const profileArg = profile ? `--profile=${shellQuote(profile)}` : '';
  const outputArg = `--output=${shellQuote(output)}`;
  const appArg = `--app="node ${scriptPath}"`;
  const command = `cdk deploy ${profileArg} --require-approval=${shellQuote(requireApproval)} ${outputArg} --notices=false ${appArg}`;

  printSection('CDK Execution');
  console.log(cyan(bold('Command:')), dim(command.split(' --')[0] + ' ...'));
  console.log('');

  // Forward the resolved platform base URL into the CDK synth subprocess (it reads
  // only process.env) for the PluginLookup Lambda endpoint + registry pull-host
  // fallback. Absent in local-spec mode.
  const cdkEnv: Record<string, string> = { PIPELINE_PROPS: encoded };
  if (input.platformBaseUrl) cdkEnv.PLATFORM_BASE_URL = input.platformBaseUrl;

  // Throws on failure — surfaced by the caller as a non-zero exit.
  const result = executeCdkShellCommand(command, { debug, showOutput: true, env: cdkEnv });

  console.log('');
  printSection('Deployment Complete');
  printKeyValue({
    'Execution ID': executionId,
    'Duration': `${result.duration}ms`,
    'Output Directory': output,
    'Status': '✓ Success',
  });

  // Register the pipeline ARN for event reporting (non-blocking). Skipped when
  // there's no platform client (local-spec) or no orgId to scope it to.
  if (!input.platformClient || !input.platformPipelineUrl) {
    printInfo('Skipping pipeline registry (no platform client)');
    return;
  }
  if (!pipeline.orgId) {
    printWarning('Pipeline has no orgId — skipping registration');
    return;
  }

  // Build the payload up-front so a POST failure can persist the SAME payload as a
  // pending intent for `pipeline register` to drain later (STS lookups aren't retried).
  let payload;
  try {
    payload = await buildRegistryPayload(
      {
        id: pipeline.id,
        orgId: pipeline.orgId,
        pipelineName: pipeline.pipelineName,
        project: pipeline.project,
        organization: pipeline.organization,
      },
      region,
    );
  } catch (buildError) {
    printWarning('Could not build registry payload — skipping registration', {
      error: buildError instanceof Error ? buildError.message : String(buildError),
    });
    return;
  }

  try {
    await input.platformClient.post(`${input.platformPipelineUrl}/registry`, payload);
    printSuccess('Pipeline registered for event reporting', { pipelineId: payload.pipelineId });
  } catch (regError) {
    try {
      const intentPath = await writePendingIntent(payload);
      printWarning('Pipeline registry update failed; queued for retry', {
        error: regError instanceof Error ? regError.message : String(regError),
        retry: 'pipeline-manager pipeline register',
        intent: intentPath,
      });
    } catch (writeErr) {
      printWarning('Pipeline registry update failed (retry queue also failed)', {
        error: regError instanceof Error ? regError.message : String(regError),
        queueError: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  }
}
