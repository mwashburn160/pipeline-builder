// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { PluginFilter, Plugin } from '@pipeline-builder/pipeline-data';
import type { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';
import axios, { type AxiosInstance, AxiosError } from 'axios';
// Import the dependency-free leaf, NOT `app-config.js`/`CoreConstants`: the latter
// transitively pulls infrastructure-config → aws-cdk-lib, which esbuild then tries
// to bundle into this Lambda (hundreds of MB → OOM/SIGKILL during cold-start synth).
import {
  HANDLER_TIMEOUT_MS,
  HANDLER_MAX_RETRIES,
  HANDLER_RETRY_DELAY_MS,
  HANDLER_DEFAULT_BASE_URL,
} from '../config/handler-constants.js';
import { unwrapLookup } from '../core/plugin-lookup-envelope.js';
import { createPlatformCredential, isCredentialRefusal } from './platform-credential.js';

/**
 * Structured logger for Lambda (outputs JSON to CloudWatch).
 * Debug messages only emitted when LOG_LEVEL=debug.
 */
function logEntry(level: string, tag: string, message: string, data?: unknown) {
  const line = JSON.stringify({ level, tag, message, data, ts: new Date().toISOString() });
  switch (level) {
    case 'ERROR': console.error(line); break;
    case 'WARN': console.warn(line); break;
    case 'DEBUG': if (process.env.LOG_LEVEL === 'debug') console.debug(line); break;
    default: console.log(line);
  }
}

const lambdaLog = {
  info: (tag: string, message: string, data?: unknown) => logEntry('INFO', tag, message, data),
  error: (tag: string, message: string, data?: unknown) => logEntry('ERROR', tag, message, data),
  warn: (tag: string, message: string, data?: unknown) => logEntry('WARN', tag, message, data),
  debug: (tag: string, message: string, data?: unknown) => logEntry('DEBUG', tag, message, data),
};

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Platform secret name — injected as PLATFORM_SECRET_NAME env var by PluginLookup construct. */
const PLATFORM_SECRET_NAME = process.env.PLATFORM_SECRET_NAME;
if (!PLATFORM_SECRET_NAME) {
  throw new Error('PLATFORM_SECRET_NAME environment variable is required');
}

/**
 * The service-account key (`pb_sa_…`) from Secrets Manager, cached for the warm
 * container. The plugin API trades it for a short-lived JWT itself, so the key
 * goes out as the Bearer credential. Create the secret with
 * `pipeline-manager infra store-token`.
 */
const credential = createPlatformCredential({ secretName: PLATFORM_SECRET_NAME });

/** @internal Reset cached credential (for testing only). */
export function _resetCredentialsCache(): void { credential.reset(); }

/** The API refused the credential (401/403) — the caller may refresh it and retry once. */
class CredentialRefusedError extends Error {}

/**
 * Creates a pre-configured Axios instance for API requests.
 *
 * @param baseURL - Base URL of the target API
 * @param key - service-account key sent as the Bearer credential
 * @returns Configured Axios instance
 */
function create(baseURL: string, key: string): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: HANDLER_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
  });
}

/**
 * Fetches plugin configuration from the external API with retry logic.
 * Retries on transient failures (429, 502, 503, 504, network errors)
 * with exponential backoff.
 *
 * @param api - Configured Axios instance
 * @param pluginFilter - Filter criteria for the plugin lookup
 * @returns The plugin data returned by the API
 * @throws Error on persistent failure, timeout or invalid response
 */
async function fetch(api: AxiosInstance, pluginFilter: PluginFilter): Promise<Plugin> {
  lambdaLog.debug('FETCH', 'Starting plugin fetch', { filter: pluginFilter });

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= HANDLER_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = HANDLER_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      lambdaLog.info('RETRY', `Attempt ${attempt + 1}/${HANDLER_MAX_RETRIES + 1} after ${delay}ms`);
      await sleep(delay);
    }

    try {
      const { data: body, status } = await api.post<unknown>('/api/plugins/lookup', {
        filter: pluginFilter,
      });

      const { plugin: data, warnings } = unwrapLookup(body);
      if (!data) {
        throw new Error('Empty response data from API');
      }
      // Lifecycle warnings (deprecated / yanked-but-pinned) — surfaced in the
      // deploy log; the lookup still succeeds.
      for (const message of warnings) lambdaLog.warn('LIFECYCLE', message, { plugin: data.name, version: data.version });

      lambdaLog.info('FETCH', 'Plugin fetched successfully', {
        status,
        plugin: data.name,
        version: data.version,
        id: data.id,
      });

      return data;
    } catch (error) {
      if (error instanceof AxiosError) {
        if (error.code === 'ECONNABORTED') {
          lambdaLog.error('FETCH', `Plugin lookup timed out after ${HANDLER_TIMEOUT_MS}ms`);
          throw new Error(`Plugin lookup timed out after ${HANDLER_TIMEOUT_MS}ms`);
        }

        const retryable = error.response
          ? RETRYABLE_STATUSES.has(error.response.status)
          : RETRYABLE_CODES.has(error.code ?? '');

        const msg = error.response
          ? `API error ${error.response.status}: ${error.response.statusText}`
          : error.code || error.message;

        if (isCredentialRefusal(error.response?.status)) {
          lambdaLog.warn('AUTH', `Credential refused: ${msg}`);
          throw new CredentialRefusedError(`Failed to fetch plugin: ${msg}`);
        }

        if (retryable && attempt < HANDLER_MAX_RETRIES) {
          lambdaLog.info('RETRY', `Retryable error: ${msg}`, { attempt: attempt + 1 });
          lastError = new Error(`Failed to fetch plugin: ${msg}`);
          continue;
        }

        // Don't log the upstream body verbatim — it may carry a stack trace,
        // a request payload echo, or other sensitive data we shouldn't echo
        // into Lambda CloudWatch logs. Keep just the high-level shape.
        const safeBody = error.response?.data && typeof error.response.data === 'object'
          ? { code: (error.response.data as { code?: string }).code, message: (error.response.data as { message?: string }).message }
          : undefined;
        lambdaLog.error('FETCH', msg, { responseBody: safeBody });
        throw new Error(`Failed to fetch plugin: ${msg}`);
      }

      throw error instanceof Error ? error : new Error('Unknown error during plugin fetch');
    }
  }

  throw lastError ?? new Error('Failed to fetch plugin after retries');
}

/**
 * Look the plugin up with the cached credential. On a 401/403 the key was most
 * likely rotated underneath this warm container (token-renew stores the new key
 * and revokes the old one), so drop the cache, re-read the secret and retry once.
 */
async function lookupWithCredentialRefresh(baseURL: string, pluginFilter: PluginFilter): Promise<Plugin> {
  try {
    return await fetch(create(baseURL, await credential.getKey()), pluginFilter);
  } catch (err) {
    if (!(err instanceof CredentialRefusedError)) throw err;
    credential.invalidate();
    lambdaLog.info('AUTH', 'Re-reading the service-account key from Secrets Manager and retrying once');
    return fetch(create(baseURL, await credential.getKey()), pluginFilter);
  }
}

/**
 * Validates the plugin filter object
 *
 * @param pluginFilter - Filter to validate
 * @returns true if valid
 * @throws Error if invalid
 */
function validatePluginFilter(pluginFilter: unknown): pluginFilter is PluginFilter {
  if (!pluginFilter || typeof pluginFilter !== 'object') {
    throw new Error('Missing or invalid pluginFilter');
  }

  const filter = pluginFilter as Record<string, unknown>;
  if (!filter.name && !filter.id && !filter.version && !filter.orgId) {
    throw new Error('PluginFilter must have at least one criterion (name, id, version, or orgId)');
  }

  return true;
}

/**
 * Lambda handler for CloudFormation Custom Resource that performs plugin lookup.
 *
 * Authenticates with the service-account key from AWS Secrets Manager (PLATFORM_SECRET_NAME env var).
 * Create the secret with: `pipeline-manager infra store-token`
 *
 * Request Types:
 * - Create/Update: fetches and returns plugin configuration from API
 * - Delete: no-op (always succeeds)
 *
 * Response:
 * - Success: Returns base64-encoded plugin JSON in Data.ResultValue
 * - Failure: Returns error message in Reason
 *
 * @param event - CloudFormation custom resource event
 * @returns CloudFormation response
 *
 * @example
 * Custom Resource Properties:
 * ```json
 * {
 *   "baseURL": "https://api.example.com",
 *   "pluginFilter": {
 *     "name": "nodejs-build",
 *     "version": "1.0.0",
 *     "isActive": true
 *   }
 * }
 * ```
 */
export const handler = async (
  event: CloudFormationCustomResourceEvent,
): Promise<CloudFormationCustomResourceResponse> => {
  // NOTE: never log event.StackId here — the CloudFormation Stack ARN embeds the
  // AWS account id (arn:aws:cloudformation:<region>:<ACCOUNT_ID>:stack/…), which
  // must never be persisted to CloudWatch. requestId + logicalResourceId are
  // sufficient for correlation. (StackId is still returned in the CFN response
  // body below — that is the mandatory CFN protocol field and is not a log.)
  lambdaLog.info('START', `${event.RequestType} request received`, {
    logicalResourceId: event.LogicalResourceId,
    requestId: event.RequestId,
  });

  const baseResponse: Partial<CloudFormationCustomResourceResponse> = {
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    PhysicalResourceId: event.LogicalResourceId,
  };

  try {
    // Handle Delete - always succeed (no-op)
    if (event.RequestType === 'Delete') {
      lambdaLog.info('DELETE', 'No-op - returning SUCCESS');
      return {
        ...baseResponse,
        Status: 'SUCCESS',
        Reason: 'Delete completed (no-op)',
      } as CloudFormationCustomResourceResponse;
    }

    // Extract and validate properties
    const pluginFilter = event.ResourceProperties.pluginFilter;
    const baseURL = event.ResourceProperties.baseURL || HANDLER_DEFAULT_BASE_URL;

    if (!baseURL.startsWith('https://') && !baseURL.startsWith('http://')) {
      throw new Error(`Invalid baseURL: "${baseURL}" — must start with http:// or https://`);
    }

    lambdaLog.info('CONFIG', 'Configuration loaded', { baseURL, pluginFilter });

    validatePluginFilter(pluginFilter);

    lambdaLog.info('FETCH', 'Initiating plugin lookup...');
    const plugin = await lookupWithCredentialRefresh(baseURL, pluginFilter);
    lambdaLog.info('FETCH', 'Plugin retrieved successfully', {
      name: plugin.name,
      version: plugin.version,
      id: plugin.id,
    });

    // Strip large fields to stay within CloudFormation's 4096-byte Data limit.
    // CDK constructs only need the fields used by createCodeBuildStep().
    const slim = {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      pluginType: plugin.pluginType,
      computeType: plugin.computeType,
      commands: plugin.commands,
      installCommands: plugin.installCommands,
      env: plugin.env,
      metadata: plugin.metadata,
      primaryOutputDirectory: plugin.primaryOutputDirectory,
      secrets: plugin.secrets,
      failureBehavior: plugin.failureBehavior,
      timeout: plugin.timeout,
    };

    const encoded = Buffer.from(JSON.stringify(slim), 'utf-8').toString('base64');
    lambdaLog.debug('ENCODE', 'Encoded plugin data', { length: encoded.length });

    return {
      ...baseResponse,
      Status: 'SUCCESS',
      Reason: `Plugin '${plugin.name}' (v${plugin.version}) retrieved successfully`,
      Data: {
        ResultValue: encoded,
      },
    } as CloudFormationCustomResourceResponse;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unexpected error occurred';
    lambdaLog.error('ERROR', 'Handler failed', {
      reason,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      ...baseResponse,
      Status: 'FAILED',
      Reason: reason,
    } as CloudFormationCustomResourceResponse;
  } finally {
    lambdaLog.info('END', 'Custom resource execution completed');
  }
};
