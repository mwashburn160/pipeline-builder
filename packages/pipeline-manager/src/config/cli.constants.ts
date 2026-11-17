// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { defaultPipelineName as sharedDefaultPipelineName, pipelineIdentityHash } from '@pipeline-builder/api-core';
import { randomBytes } from 'crypto';
import { readFileSync } from 'node:fs';

// ESM has no synchronous named JSON import (Node only exposes a default export,
// and importing `../../package.json` would also fall outside `rootDir: src`), so
// read the version from package.json at load time relative to this module.
const { version, engines } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
) as { version: string; engines?: { node?: string } };

/**
 * The lowest Node.js version the CLI supports, read from package.json
 * `engines.node` (a `>= x.y.z` floor) so the start-up warning can never name a
 * different floor than the one npm enforces.
 */
export const NODE_VERSION_FLOOR = /(\d+(?:\.\d+){0,2})/.exec(engines?.node ?? '')?.[1] ?? '0';

/** Whether `nodeVersion` (`v26.13.1` or `26.13.1`) is at or above `floor` (`26.13.1`). */
export function meetsNodeVersionFloor(nodeVersion: string, floor: string = NODE_VERSION_FLOOR): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const have = parse(nodeVersion);
  const need = parse(floor);
  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Application metadata
 */
export const APP_NAME = 'pipeline-manager';
export const APP_VERSION = version;
export const APP_DESCRIPTION = 'A CLI tool to manage pipelines and plugins';

/**
 * Banner configuration for CLI startup
 */
export const BANNER_OPTIONS = {
  font: 'Doom' as const,
  horizontalLayout: 'fitted' as const,
  getWidth: () => process.stdout.columns ?? 80,
} as const;

/**
 * Output format types
 */
export type OutputFormat = 'table' | 'json' | 'yaml' | 'csv';

/**
 * Default timeouts (in milliseconds)
 */
export const TIMEOUTS = {
  HTTP_REQUEST: 30000,
  HEALTH_CHECK: 5000,
} as const;

/**
 * File size limits (in bytes)
 */
export const FILE_SIZE_LIMITS = {
  PLUGIN: 4 * 1024 * 1024 * 1024, // 4GB
  PIPELINE_PROPS: 10 * 1024 * 1024, // 10MB
} as const;

/**
 * Environment variable names
 */
export const ENV_VARS = {
  PLATFORM_TOKEN: 'PLATFORM_TOKEN',
  PLATFORM_BASE_URL: 'PLATFORM_BASE_URL',
  CLI_CONFIG_PATH: 'CLI_CONFIG_PATH',
  PLATFORM_TLS_VERIFY: 'PLATFORM_TLS_VERIFY',
  AWS_REGION: 'AWS_REGION',
  DEBUG: 'DEBUG',
} as const;

/**
 * Check if debug mode is enabled
 */
export function isDebugMode(options?: { debug?: boolean }): boolean {
  return options?.debug ?? process.env.DEBUG === 'true';
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Format duration for display
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const remainingSeconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Generate cryptographically random execution ID for request tracing.
 */
export function generateExecutionId(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Table display options (box-drawing characters)
 */
export const TABLE_OPTIONS = {
  border: {
    topBody: '─',
    topJoin: '┬',
    topLeft: '┌',
    topRight: '┐',
    bottomBody: '─',
    bottomJoin: '┴',
    bottomLeft: '└',
    bottomRight: '┘',
    bodyLeft: '│',
    bodyRight: '│',
    bodyJoin: '│',
    joinBody: '─',
    joinLeft: '├',
    joinRight: '┤',
    joinJoin: '┼',
  },
} as const;

/**
 * Validate boolean string from CLI input
 */
export function validateBoolean(value: string, fieldName: string): boolean {
  const normalized = value.toLowerCase().trim();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value for ${fieldName}: "${value}". Use true/false, yes/no, or 1/0.`);
}

/**
 * Validate and parse a numeric CLI parameter within optional bounds.
 */
export function validateNumber(value: string | number | undefined | null, fieldName: string, min?: number, max?: number): number {
  // A missing value (e.g. a list command that forgot its commander default)
  // would otherwise throw a cryptic `undefined.trim()` TypeError — fail with a
  // clear validation message instead.
  if (value === undefined || value === null || value === '') {
    throw new Error(`Invalid ${fieldName}: a value is required`);
  }
  // Reject partial parses ("12abc" -> 12) and non-integers ("5.9" -> 5) that
  // `parseInt` would otherwise accept silently.
  if (typeof value === 'string' && !/^-?\d+$/.test(value.trim())) {
    throw new Error(`Invalid ${fieldName}: must be a whole number`);
  }
  const num = typeof value === 'number' ? value : parseInt(value.trim(), 10);
  if (!Number.isInteger(num)) {
    throw new Error(`Invalid ${fieldName}: must be a whole number`);
  }
  if (min !== undefined && num < min) {
    throw new Error(`Invalid ${fieldName}: must be >= ${min}`);
  }
  if (max !== undefined && num > max) {
    throw new Error(`Invalid ${fieldName}: must be <= ${max}`);
  }
  return num;
}

/**
 * Validate sort parameter format (e.g., "createdAt:desc").
 * Returns the validated sort string, or the default if invalid.
 */
const SORT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*:(asc|desc)$/;

export function validateSort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!SORT_PATTERN.test(value)) {
    throw new Error(`Invalid sort format: "${value}". Expected "field:asc" or "field:desc".`);
  }
  return value;
}

/**
 * Reject strings containing shell metacharacters.
 * Used to sanitize CLI inputs before passing to shell commands.
 */
const SHELL_UNSAFE = /[;&|`$(){}[\]<>!#~*?\\\n\r]/;

export function assertShellSafe(
  value: string,
  fieldName: string,
  opts: { redactValue?: boolean } = {},
): void {
  if (SHELL_UNSAFE.test(value)) {
    // `redactValue` is for secrets (tokens, passwords) — never echo the offending
    // value into an error/log line when the field is sensitive.
    const detail = opts.redactValue ? '' : `: "${value}"`;
    throw new Error(`${fieldName} contains unsafe characters${detail}`);
  }
}

/**
 * POSIX single-quote a value (escaping embedded single quotes) for safe shell
 * interpolation. Single source of truth — drift in a shell-quoting helper is
 * security-relevant, so both agent modules import this rather than re-declaring it.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Canonical default pipeline name when none is given — api-core's
 * `defaultPipelineName`, the SAME rule pipeline-core's PipelineConfiguration
 * uses (`<org>-<project>-pipeline`, non-alphanumeric → '_', lowercased, plus a
 * `-<hash>` of the raw pair when that is lossy), so the CLI's create and
 * registry paths derive the name the CDK builder actually deploys (a mismatch
 * breaks StartPipelineExecution against the registered name).
 */
export function defaultPipelineName(organization: string, project: string): string {
  return sharedDefaultPipelineName(organization, project);
}

/** CloudFormation's stack-name rule (the same pattern aws-cdk-lib's `Stack` enforces). */
const STACK_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/** CloudFormation's stack-name length limit. */
const STACK_NAME_MAX_LENGTH = 128;

/**
 * The CloudFormation stack name a pipeline deploys as: `<project>-<organization>`,
 * lowercased, with `_` turned into `-` — and, when the given pair is not
 * already clean (letters, digits, hyphens), `-<hash>` of the raw pair
 * (`pipelineIdentityHash`) so distinct inputs never share a stack. A project name may contain underscores
 * and a stack name may not (`spring_boot` gave the invalid `spring_boot-system`).
 *
 * Shared by the synth app (`boilerplate.ts`, which names the stack) and the
 * registry payload (`utils/registry.ts`, which records it), so the deployed
 * stack and its registry record always agree. Only the derived name changes;
 * the project and organization values are kept as they are everywhere else.
 *
 * Throws when the result is still not a valid stack name: CloudFormation wants a
 * letter first, then letters, digits and hyphens, at most 128 characters. CDK
 * checks the pattern too, but only at synth, and past 128 characters it silently
 * swaps in a hashed name, so the registry would record a stack that doesn't exist.
 */
export function pipelineStackName(project: string, organization: string): string {
  // `_` → `-` is lossy (`spring_boot` and `spring-boot` would share a stack),
  // so a pair it changes carries a hash of the raw pair; a clean pair keeps
  // the stack name it always had.
  const hash = pipelineIdentityHash(project, organization);
  const name = `${project}-${organization}${hash ? `-${hash}` : ''}`.toLowerCase().replace(/_/g, '-');
  if (name.length > STACK_NAME_MAX_LENGTH) {
    throw new Error(
      `Stack name '${name}' (from project '${project}' and organization '${organization}') is ${name.length} characters; `
      + `CloudFormation allows at most ${STACK_NAME_MAX_LENGTH}. Shorten the project or organization name.`,
    );
  }
  if (!STACK_NAME_PATTERN.test(name)) {
    throw new Error(
      `Stack name '${name}' (from project '${project}' and organization '${organization}') is not a valid CloudFormation stack name: `
      + 'it must start with a letter and contain only letters, digits, hyphens or underscores (underscores become hyphens).',
    );
  }
  return name;
}


/**
 * CloudFormation stack name for the event-ingestion infra. Shared so `setup-events`
 * (which deploys it) and `redrive-events` (which resolves the DLQ/queue from it)
 * can never drift apart.
 */
export const EVENTS_STACK_NAME = 'pipeline-builder-events';
