import { execFileSync } from 'child_process';
import axios from 'axios';
import pico from 'picocolors';
import { ApiClient } from './api-client';
import { Config, getConfigWithOptions } from './config-loader';
import { printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from './output-utils';
import { formatDuration, generateExecutionId } from '../config/cli.constants';

const { bold, cyan, green, magenta } = pico;

/** Default secret name for stored credentials. */
const DEFAULT_CREDENTIALS_SECRET = 'pipeline-builder/system/credentials';

/**
 * Print command header with section title and execution ID.
 * Returns the execution ID for use in error handlers and summaries.
 */
export function printCommandHeader(title: string, subtitle?: string): string {
  const executionId = generateExecutionId();
  printSection(title);
  console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold(subtitle || title))}`);
  console.log('');
  return executionId;
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
 * 2. --store-credentials flag → fetch credentials from AWS Secrets Manager, then authenticate
 *
 * @returns JWT token string
 */
export async function resolveToken(options: {
  storeCredentials?: boolean;
  verifySsl?: boolean;
  region?: string;
  profile?: string;
}): Promise<string> {
  // Path 1: PLATFORM_TOKEN env var
  if (process.env.PLATFORM_TOKEN) {
    printInfo('Using PLATFORM_TOKEN from environment');
    return process.env.PLATFORM_TOKEN;
  }

  const baseUrl = process.env.PLATFORM_BASE_URL || 'https://localhost:8443';

  // Path 2: --store-credentials → read from Secrets Manager
  if (options.storeCredentials) {
    printInfo('Fetching credentials from Secrets Manager', { secret: DEFAULT_CREDENTIALS_SECRET });

    const smArgs = [
      'secretsmanager', 'get-secret-value',
      '--secret-id', DEFAULT_CREDENTIALS_SECRET,
      '--query', 'SecretString',
      '--output', 'text',
    ];
    if (options.region) smArgs.push('--region', options.region);
    if (options.profile) smArgs.push('--profile', options.profile);

    const credentialsJson = execFileSync('aws', smArgs, { encoding: 'utf-8' }).trim();
    printSuccess('Credentials retrieved from Secrets Manager');

    return authenticateWithCredentials(baseUrl, credentialsJson);
  }

  throw new Error(
    'Authentication required. Use one of:\n' +
    '  - Set PLATFORM_TOKEN environment variable\n' +
    '  - Pass --store-credentials to fetch from AWS Secrets Manager',
  );
}

/**
 * Initialize and return an authenticated API client.
 *
 * Supports two auth methods:
 * 1. PLATFORM_TOKEN env var
 * 2. --store-credentials → fetch from Secrets Manager, authenticate, set PLATFORM_TOKEN
 */
export async function createAuthenticatedClientAsync(options: {
  storeCredentials?: boolean;
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
 * Use createAuthenticatedClientAsync for --store-credentials support.
 */
export function createAuthenticatedClient(options: { verifySsl?: boolean }): ApiClient {
  const config: Config = getConfigWithOptions(options);
  printInfo('Initializing API client', { baseUrl: config.api.baseUrl });
  const client = new ApiClient(config);

  if (!client.isAuthenticated()) {
    printError('Not authenticated', { hint: 'Set PLATFORM_TOKEN or use --store-credentials' });
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

/**
 * Authenticate using credentials JSON (email/password from Secrets Manager).
 *
 * @param baseUrl - Platform API base URL
 * @param credentialsJson - JSON string with { email, password }
 * @returns JWT token
 */
export async function authenticateWithCredentials(baseUrl: string, credentialsJson: string): Promise<string> {
  const creds = JSON.parse(credentialsJson) as { email?: string; password?: string };
  if (!creds.email || !creds.password) {
    throw new Error('Credentials missing email or password fields');
  }

  printInfo('Authenticating with platform', { baseUrl });

  const { data } = await axios.post(`${baseUrl}/api/auth/login`, {
    email: creds.email,
    password: creds.password,
  }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });

  const token = data?.data?.accessToken || data?.token;
  if (!token) throw new Error('Authentication failed — no token in response');

  printSuccess('Authenticated');
  return token;
}
