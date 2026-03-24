import pico from 'picocolors';
import { ApiClient } from './api-client';
import { Config, getConfigWithOptions } from './config-loader';
import { printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from './output-utils';
import { formatDuration, generateExecutionId } from '../config/cli.constants';

const { bold, cyan, green, magenta } = pico;

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
 * Initialize and return an authenticated API client.
 * Loads config from options, creates client, validates authentication.
 *
 * @throws Error if PLATFORM_TOKEN is not set
 */
export function createAuthenticatedClient(options: { verifySsl?: boolean }): ApiClient {
  const config: Config = getConfigWithOptions(options);
  printInfo('Initializing API client', { baseUrl: config.api.baseUrl });
  const client = new ApiClient(config);

  if (!client.isAuthenticated()) {
    printError('Not authenticated', { hint: 'Set PLATFORM_TOKEN environment variable' });
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
