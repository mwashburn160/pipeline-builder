// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { errorMessage } from '@pipeline-builder/api-core';
import {
  parseRuntimeCheckSteps,
  RUNTIME_CHECK_STEPS_ENV,
  RUNTIME_CHECK_VERDICTS,
  type RuntimeCheckResult,
  type RuntimeCheckStep,
  type StepManifestEntry,
} from '@pipeline-builder/pipeline-core';
import { Command } from 'commander';
import pico from 'picocolors';
import type { ApiClient } from '../utils/api-client.js';
import {
  createAuthenticatedClientAsync, printCommandHeader, printSslWarning, withProfileOption, withRegionOption, withSslOptions,
} from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printInfo, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { setPipelineId } from '../utils/request-context.js';
import { unwrapEnvelope } from '../utils/response-utils.js';

const { bold, cyan, red, yellow } = pico;

interface VerifyOptions {
  pipelineId: string;
  stepsFile?: string;
  manifest?: string;
  storeTokens?: boolean;
  verifySsl?: boolean;
  region?: string;
  profile?: string;
  json?: boolean;
  strict?: boolean;
}

/**
 * The steps to ask about, from (first match): `--steps-file` (JSON
 * `[{ stepKey, imageDigest }]`), `--manifest` (a synth's `pb-step-manifest.json`
 * — rows carrying a stepKey and a digest), or the `PB_VERIFY_STEPS` env var the
 * synthesized verify step carries. No source, or an empty list, is an error: a
 * check that asked about nothing must not pass.
 */
export function loadVerifySteps(options: Pick<VerifyOptions, 'stepsFile' | 'manifest'>, env: NodeJS.ProcessEnv = process.env): RuntimeCheckStep[] {
  let steps: RuntimeCheckStep[];
  if (options.stepsFile) {
    steps = parseRuntimeCheckSteps(readFileSync(options.stepsFile, 'utf8'));
  } else if (options.manifest) {
    const rows = JSON.parse(readFileSync(options.manifest, 'utf8')) as StepManifestEntry[];
    if (!Array.isArray(rows)) throw new ValidationError('--manifest must be a step manifest (a JSON array)', 'manifest');
    steps = parseRuntimeCheckSteps(JSON.stringify(rows
      .filter((r) => r.stepKey && r.imageDigest)
      .map((r) => ({ stepKey: r.stepKey, imageDigest: r.imageDigest }))));
  } else if (env[RUNTIME_CHECK_STEPS_ENV]) {
    steps = parseRuntimeCheckSteps(env[RUNTIME_CHECK_STEPS_ENV]!);
  } else {
    throw new ValidationError(`No steps to verify: pass --steps-file or --manifest, or set ${RUNTIME_CHECK_STEPS_ENV}`, 'steps');
  }
  if (steps.length === 0) throw new ValidationError('No image-backed steps to verify', 'steps');
  return steps;
}

/** `POST /api/plugins/runtime-check` (contract C2), envelope unwrapped. */
export async function runtimeCheck(client: ApiClient, pipelineId: string, steps: readonly RuntimeCheckStep[]): Promise<RuntimeCheckResult> {
  const response = await client.post<unknown>(`${client.getConfig().api.pluginUrl}/runtime-check`, { pipelineId, steps });
  const body = unwrapEnvelope(response) as Partial<RuntimeCheckResult>;
  if (!body.verdict || !RUNTIME_CHECK_VERDICTS.includes(body.verdict)) {
    throw new Error('runtime-check returned no readable verdict');
  }
  return { verdict: body.verdict, steps: Array.isArray(body.steps) ? body.steps : [] };
}

const VERDICT_STYLE: Record<string, (s: string) => string> = {
  ok: (t) => t,
  info: cyan,
  warning: yellow,
  error: red,
  critical: (t) => bold(red(t)),
};

/**
 * Registers `plugin verify`: ask the platform what it now knows about the
 * plugin images a pipeline runs — a CVE flagged, a KEV listing or an
 * org-policy change since the synth that pinned them — and print the graded
 * verdict. Vulnerability state is REPORTED, never enforced: the command exits
 * 0 whatever the verdict (the platform also notifies on a pipeline running a
 * vulnerable plugin). If the check itself cannot run (platform unreachable,
 * unreadable answer) it warns and exits 0, or exits non-zero with `--strict`.
 *
 * The synthesized pipeline runs this as a report-only step in each stage when
 * the `aws:cdk:operations:runtimevulncheck` metadata flag is on.
 *
 * @example
 * ```bash
 * pipeline-manager plugin verify --pipeline-id <id> --manifest cdk.out/pb-step-manifest.json
 * pipeline-manager plugin verify --pipeline-id "$PIPELINE_ID" --store-tokens   # in CodeBuild (PB_VERIFY_STEPS)
 * ```
 */
export function verifyPlugins(program: Command): void {
  withSslOptions(
    withRegionOption(
      withProfileOption(program
        .command('verify')
        .description('Report, at run time, the current vulnerability state of a pipeline\'s pinned plugin images (never fails on it)')
        .requiredOption('-p, --pipeline-id <id>', 'Pipeline ID')
        .option('--steps-file <file>', 'JSON [{ stepKey, imageDigest }] to check')
        .option('--manifest <file>', 'A synth\'s pb-step-manifest.json to check')
        .option('--store-tokens', 'Authenticate using the key in AWS Secrets Manager (PLATFORM_SECRET_NAME)', false)
        .option('--strict', 'Exit non-zero when the check itself cannot run (never for vulnerability state)', false)
        .option('--json', 'Print the verdict as JSON', false)),
    ),
  )
    .action(async (options: VerifyOptions) => {
      const executionId = printCommandHeader('Plugin Run-time Check', undefined, { quiet: options.json });
      try {
        printSslWarning(options.verifySsl);
        // Bad input is the caller's bug, not an outage: always an error.
        const steps = loadVerifySteps(options);
        printInfo('Checking plugin images', { pipelineId: options.pipelineId, steps: steps.length });
        setPipelineId(options.pipelineId);

        let result: RuntimeCheckResult;
        try {
          const client = await createAuthenticatedClientAsync(options);
          result = await runtimeCheck(client, options.pipelineId, steps);
        } catch (error) {
          if (options.strict) throw error;
          printWarning('Run-time plugin check could not run — continuing (pass --strict to fail instead)', { error: errorMessage(error) });
          return;
        }

        if (options.json) console.log(JSON.stringify(result, null, 2));
        printSection(`Verdict: ${VERDICT_STYLE[result.verdict]!(result.verdict.toUpperCase())}`);
        for (const step of result.steps) {
          if (step.verdict === 'ok') continue;
          for (const reason of step.reasons) {
            const sev = reason.severity ?? step.verdict;
            const tag = (VERDICT_STYLE[sev] ?? yellow)(`[${sev.toUpperCase()}]`);
            console.log(`  ${tag} ${step.stepKey} (${step.imageDigest.slice(0, 19)}…) ${reason.code}: ${reason.message}`);
          }
        }
        const flagged = result.steps.filter((s) => s.verdict !== 'ok').length;
        if (result.verdict === 'ok') printSuccess('Run-time plugin check: no findings');
        else printWarning(`Run-time plugin check: ${flagged} step(s) with findings (worst: ${result.verdict}) — reported, not enforced`);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'plugin-verify', executionId, pipelineId: options.pipelineId },
        });
      }
    });
}
