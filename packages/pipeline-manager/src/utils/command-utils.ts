// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { type Command } from 'commander';
import pico from 'picocolors';
import { ApiClient } from './api-client.js';
import { getSecretValue } from './aws-secrets.js';
import { type Config, getConfigWithOptions } from './config-loader.js';
import { printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from './output-utils.js';
import { formatDuration, generateExecutionId } from '../config/cli.constants.js';

const { bold, cyan, green, magenta } = pico;

/**
 * Print command header with section title and execution ID.
 * Returns the execution ID for use in error handlers and summaries.
 *
 * Pass `{ quiet: true }` to suppress the decorative output while still getting the
 * id — used both by `--quiet` callers and by `--json` commands (so the banner
 * doesn't land on stdout ahead of the JSON payload and break `… --json | jq`).
 */
export function printCommandHeader(title: string, subtitle?: string, opts?: { quiet?: boolean }): string {
  const executionId = generateExecutionId();
  if (!opts?.quiet) {
    printSection(title);
    console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold(subtitle || title))}`);
    console.log('');
  }
  return executionId;
}

/** Attach the standard `--verify-ssl` / `--no-verify-ssl` pair. The two together
 *  give Commander an explicit tri-state `options.verifySsl` (true/false/undefined).
 *  Returns the command so it composes: `withSslOptions(program.command('x'))…`. */
export function withSslOptions<T extends Command>(cmd: T): T {
  return cmd
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification') as T;
}

/** Attach the standard `--region <region>` option (one canonical description).
 *  Region resolution (flag → AWS_REGION → CDK_DEFAULT_REGION → us-east-1) lives in
 *  aws-env.resolveAwsRegion. */
export function withRegionOption<T extends Command>(cmd: T): T {
  return cmd.option('--region <region>', 'AWS region (defaults to AWS_REGION / CDK_DEFAULT_REGION / us-east-1)') as T;
}

/** Attach the standard `--profile <profile>` option (one canonical description).
 *  No default is pinned so the AWS default credential chain (env vars, SSO, roles)
 *  works out of the box; --profile only selects a shared profile when set. */
export function withProfileOption<T extends Command>(cmd: T): T {
  return cmd.option('--profile <profile>', 'AWS CLI profile (defaults to the standard AWS credential chain)') as T;
}

/**
 * Print execution summary with ID, duration, and status.
 */
export function printExecutionSummary(executionId: string, duration: number): void {
  console.log('');
  printKeyValue({
    'Execution ID': executionId,
    'Duration': formatDuration(duration),
    'Status': green('✓ Success'),
  });
}

/**
 * Warn if SSL verification is disabled.
 */
export function printSslWarning(verifySsl?: boolean): void {
  if (verifySsl === false) {
    printWarning('SSL certificate verification is DISABLED');
    console.log('');
  }
}

/**
 * Resolve a platform auth token using two methods (in priority order):
 *
 * 1. PLATFORM_TOKEN env var
 * 2. --store-tokens flag → fetch credentials from AWS Secrets Manager, then authenticate
 *
 * @returns JWT token string
 */
export async function resolveToken(options: {
  storeTokens?: boolean;
  verifySsl?: boolean;
  region?: string;
  profile?: string;
}): Promise<string> {
  // Path 1: PLATFORM_TOKEN env var
  if (process.env.PLATFORM_TOKEN) {
    printInfo('Using PLATFORM_TOKEN from environment');
    return process.env.PLATFORM_TOKEN;
  }

  // Path 2: --store-tokens → read PLATFORM_SECRET_NAME from Secrets Manager
  if (options.storeTokens) {
    const secretName = process.env.PLATFORM_SECRET_NAME;
    if (!secretName) {
      throw new Error('PLATFORM_SECRET_NAME env var is required with --store-tokens');
    }

    printInfo('Fetching secret from Secrets Manager', { secret: secretName });

    const secretJson = await getSecretValue(secretName, { region: options.region, profile: options.profile });
    const secret = JSON.parse(secretJson) as Record<string, string>;
    printSuccess('Secret retrieved from Secrets Manager');

    // store-token writes the JWT to the `password` field (schema: { username: orgId,
    // password: JWT } — satisfies CodeBuild's secretsManagerCredentials), not `accessToken`.
    if (!secret.password) {
      throw new Error('Secret missing password (JWT) — run "pipeline-manager infra store-token" to generate');
    }

    printInfo('Using stored JWT token');
    return secret.password;
  }

  throw new Error(
    'Authentication required. Use one of:\n' +
    '  - Set PLATFORM_TOKEN environment variable\n' +
    '  - Pass --store-tokens with PLATFORM_SECRET_NAME env var',
  );
}

/**
 * Initialize and return an authenticated API client.
 *
 * Supports two auth methods:
 * 1. PLATFORM_TOKEN env var
 * 2. --store-tokens + PLATFORM_SECRET_NAME env var → fetch token from Secrets Manager
 */
export async function createAuthenticatedClientAsync(options: {
  storeTokens?: boolean;
  verifySsl?: boolean;
  region?: string;
  profile?: string;
}): Promise<ApiClient> {
  // Resolve token and set it in env so ApiClient/getConfig can find it
  if (!process.env.PLATFORM_TOKEN) {
    const token = await resolveToken(options);
    process.env.PLATFORM_TOKEN = token;
  }

  return createAuthenticatedClient(options);
}

/**
 * Initialize and return an authenticated API client (sync — requires PLATFORM_TOKEN).
 * Use createAuthenticatedClientAsync for --store-tokens support.
 */
export function createAuthenticatedClient(options: { verifySsl?: boolean }): ApiClient {
  const config: Config = getConfigWithOptions(options);
  printInfo('Initializing API client', { baseUrl: config.api.baseUrl });
  const client = new ApiClient(config);

  if (!client.isAuthenticated()) {
    printError('Not authenticated', { hint: 'Set PLATFORM_TOKEN or use --store-tokens' });
    throw new Error('Authentication required');
  }

  printSuccess('API client initialized');
  return client;
}

/**
 * Validate a required entity ID (ULID or UUID format).
 * Returns trimmed ID.
 *
 * @throws Error if ID is empty
 */
export function validateEntityId(id: string | undefined, entityName: string): string {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    printError(`Invalid ${entityName} ID`, { provided: id });
    throw new Error(`${entityName} ID must be a non-empty string`);
  }

  const trimmed = id.trim();

  if (trimmed.length !== 26 && trimmed.length !== 36) {
    printWarning(`${entityName} ID format may be invalid`, {
      provided: trimmed,
      expectedLength: '26 characters (ULID) or 36 characters (UUID)',
      actualLength: trimmed.length,
    });
  }

  return trimmed;
}

