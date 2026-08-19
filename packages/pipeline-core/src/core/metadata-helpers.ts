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
 * Replaces all characters that are not letters or numbers with the specified value
 * @param input - The string to process
 * @param replaceValue - The character(s) to replace non-alphanumeric characters with (default: '_')
 * @returns The string with non-alphanumeric characters replaced
 */
export function replaceNonAlphanumeric(input: string, replaceValue: string = '_'): string {
  return input.replace(/[^a-zA-Z0-9]/g, replaceValue);
}
