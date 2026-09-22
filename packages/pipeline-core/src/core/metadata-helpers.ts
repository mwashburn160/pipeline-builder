// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Metadata and string helpers that are FREE of `aws-cdk-lib`.
 *
 * Split out of `pipeline-helpers.ts` (which builds CodeBuild steps and therefore
 * pulls in the CDK) so the main `@pipeline-builder/pipeline-core` entry point can
 * export them without putting `aws-cdk-lib` on every consumer's import graph.
 * Anything here that needs a CDK type belongs in `pipeline-helpers.ts` instead.
 */

import { CDK_METADATA_PREFIX, type MetaDataType } from './pipeline-types.js';

/**
 * Merge multiple metadata objects into one. Later sources override earlier ones.
 */
export function merge(...sources: Array<Partial<MetaDataType>>): MetaDataType {
  return Object.assign({}, ...sources) as MetaDataType;
}

/**
 * Extract non-namespaced metadata keys as environment variable strings.
 * Keys starting with 'aws:cdk:' are reserved for CDK construct props
 * (processed by metadata extraction functions) and are excluded here.
 *
 * All values are converted to strings for CodeBuild compatibility.
 */
export function extractMetadataEnv(metadata: MetaDataType): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(CDK_METADATA_PREFIX)) {
      env[key] = String(value);
    }
  }
  return env;
}

/** Plugin categories whose failure must NEVER be masked. A scan/security step that
 *  exits non-zero has to fail the pipeline (repo rule: a failed scan is red, never a
 *  false-green `|| true`), so such a plugin's failureBehavior is forced to 'fail'
 *  regardless of what the plugin or step authored. */
const FAIL_FAST_CATEGORIES = /scan|security|sast|dast|vuln|secret/i;

/** Resolve the effective failureBehavior: a scan/security-category plugin is pinned
 *  to 'fail'; otherwise the authored value (default 'fail'). */
export function resolveFailureBehavior(category?: string, authored?: 'fail' | 'warn' | 'ignore'): 'fail' | 'warn' | 'ignore' {
  if (category && FAIL_FAST_CATEGORIES.test(category)) return 'fail';
  return authored ?? 'fail';
}

/**
 * The first command of a step's install and build phases: `cd` into the
 * `WORKDIR` metadata/env value (default `./`, the checked-out source).
 */
export const STEP_BOOTSTRAP_CMD = 'export WORKDIR=${WORKDIR:-./}; cd ${WORKDIR}';

/**
 * Wrap build commands based on failure behavior.
 * - 'fail' (default): No wrapping — commands fail the pipeline naturally.
 * - 'warn': Run commands with `set +e`, capture failures, log warnings, continue.
 * - 'ignore': Append `|| true` to each command — failures are silently swallowed.
 *
 * Only applied to build commands, not install commands (install failures should always stop the build).
 * CDK-free so `pipeline-manager plugin test` runs a plugin's commands exactly as
 * the CodeBuild step does.
 */
export function wrapCommandsForFailureBehavior(commands: string[], behavior?: 'fail' | 'warn' | 'ignore'): string[] {
  if (!behavior || behavior === 'fail') return commands;

  // Group each command and close the group on its OWN line. Appending the
  // handler as text after the command broke on two ordinary inputs:
  //  - a trailing `# comment` commented the handler out, so
  //    `npm audit # informational || true` exited 1 and failed a step marked
  //    `ignore` (or `warn`);
  //  - a heredoc whose last line is its terminator became `EOF || true`, which
  //    is not a terminator, so the heredoc never closed.
  // The newline ends any comment and leaves a terminator alone on its line;
  // `$?` inside the handler is still the command's own exit status.
  const grouped = (cmd: string): string => `{ ${cmd}\n}`;

  if (behavior === 'ignore') {
    return commands.map(cmd => `${grouped(cmd)} || true`);
  }

  // 'warn': run all commands, capture failures, but don't stop
  return [
    'set +e',
    '_STEP_EXIT=0',
    ...commands.map(cmd => `${grouped(cmd)} || { echo "WARNING: Command failed with exit code $?"; _STEP_EXIT=1; }`),
    'set -e',
    'if [ "$_STEP_EXIT" -ne 0 ]; then echo "WARNING: One or more commands in this step failed"; fi',
  ];
}

/**
 * Replaces all characters that are not letters or numbers with the specified value
 * @param input - The string to process
 * @param replaceValue - The character(s) to replace non-alphanumeric characters with (default: '_')
 * @returns The string with non-alphanumeric characters replaced
 */
export function replaceNonAlphanumeric(input: string, replaceValue: string = '_'): string {
  return input.replace(/[^a-zA-Z0-9]/g, replaceValue);
}
