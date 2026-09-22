// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import { type Command } from 'commander';
import pico from 'picocolors';
import { ApiClient } from './api-client.js';
import { getSecretValue } from './aws-secrets.js';
import { type Config, getApiConfig, getConfigWithOptions } from './config-loader.js';
import { clearSession, isSessionUsable, loadSession, saveSession, withRefreshLock, type StoredSession } from './credential-store.js';
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
 * Renew a stored session with its refresh token, persist the rotated pair, and
 * return the new access token. Returns undefined (and forgets the session) when
 * the platform refuses it — a rotated-away or revoked token is dead, and keeping
 * it would make every later command fail the same way.
 *
 * `X-Pb-Client` is mandatory on /auth/refresh (the CSRF gate) and its value also
 * picks the transport: anything but `web` keeps the body flow the CLI uses.
 */
async function refreshStoredSession(baseUrl: string, stale: StoredSession): Promise<string | undefined> {
  // One refresh at a time per machine (see `withRefreshLock`): a second process
  // re-reads the store under the lock and uses the pair the first one saved,
  // rather than spending the same single-use refresh token again.
  return withRefreshLock(async () => {
    const current = loadSession(baseUrl);
    if (isSessionUsable(current)) return current.accessToken;
    return renewSession(baseUrl, current ?? stale);
  });
}

async function renewSession(baseUrl: string, session: StoredSession): Promise<string | undefined> {
  if (!session.refreshToken) return undefined;
  try {
    const response = await axios.post<{ data?: { accessToken?: string; refreshToken?: string; expiresIn?: number } }>(
      `${baseUrl}/api/auth/refresh`,
      { refreshToken: session.refreshToken },
      { headers: { 'Content-Type': 'application/json', 'X-Pb-Client': 'cli' }, timeout: 30_000 },
    );
    const renewed = response.data?.data;
    if (!renewed?.accessToken) return undefined;
    saveSession(baseUrl, {
      accessToken: renewed.accessToken,
      ...(renewed.refreshToken ? { refreshToken: renewed.refreshToken } : {}),
      expiresAt: Date.now() + (renewed.expiresIn ?? 900) * 1000,
      ...(session.organizationId ? { organizationId: session.organizationId } : {}),
    });
    return renewed.accessToken;
  } catch {
    clearSession(baseUrl);
    printWarning('The stored session could not be renewed — run "pipeline-manager auth login" again');
    return undefined;
  }
}

/**
 * Resolve a platform credential using three methods (in priority order):
 *
 * 1. PLATFORM_TOKEN env var (a JWT, or an opaque `pb_pat_…`/`pb_sa_…` key)
 * 2. the session `auth login` stored for this platform (renewed if it has expired)
 * 3. --store-tokens flag → the service-account key in AWS Secrets Manager
 *
 * @returns the bearer credential string
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

  // Path 2: the stored browser sign-in. Skipped entirely when --store-tokens
  // names a machine credential, so an operator's laptop session can never be
  // used where the automation credential was asked for.
  if (!options.storeTokens) {
    const baseUrl = getApiConfig().api.baseUrl;
    const stored = loadSession(baseUrl);
    if (isSessionUsable(stored)) {
      printInfo('Using the stored session from "auth login"');
      return stored.accessToken;
    }
    if (stored) {
      const renewed = await refreshStoredSession(baseUrl, stored);
      if (renewed) {
        printInfo('Renewed the stored session from "auth login"');
        return renewed;
      }
    }
  }

  // Path 3: --store-tokens → read PLATFORM_SECRET_NAME from Secrets Manager
  if (options.storeTokens) {
    const secretName = process.env.PLATFORM_SECRET_NAME;
    if (!secretName) {
      throw new Error('PLATFORM_SECRET_NAME env var is required with --store-tokens');
    }

    printInfo('Fetching secret from Secrets Manager', { secret: secretName });

    const secretJson = await getSecretValue(secretName, { region: options.region, profile: options.profile });
    const secret = JSON.parse(secretJson) as Record<string, string>;
    printSuccess('Secret retrieved from Secrets Manager');

    // store-token writes the service-account KEY to the `password` field (schema:
    // { username: orgId, password: pb_sa_… } — satisfies CodeBuild's
    // secretsManagerCredentials), not `accessToken`. The key is presented as a
    // bearer credential and exchanged server-side, so nothing here decodes it.
    if (!secret.password) {
      throw new Error('Secret missing password (service-account key) — run "pipeline-manager infra store-token" to provision one');
    }

    printInfo('Using the stored service-account key');
    return secret.password;
  }

  throw new Error(
    'Authentication required. Use one of:\n' +
    '  - Run "pipeline-manager auth login" (browser sign-in, stored for this platform)\n' +
    '  - Set PLATFORM_TOKEN to an access key from "pipeline-manager auth pat"\n' +
    '  - Pass --store-tokens with PLATFORM_SECRET_NAME env var',
  );
}

/**
 * Initialize and return an authenticated API client.
 *
 * Supports three auth methods:
 * 1. PLATFORM_TOKEN env var
 * 2. the stored `auth login` session for this platform (renewed on expiry)
 * 3. --store-tokens + PLATFORM_SECRET_NAME env var → fetch token from Secrets Manager
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
    printError('Not authenticated', { hint: 'Run "pipeline-manager auth login", set PLATFORM_TOKEN, or use --store-tokens' });
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

