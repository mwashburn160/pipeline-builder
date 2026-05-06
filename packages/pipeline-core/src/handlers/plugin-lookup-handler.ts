// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PluginFilter, Plugin } from '@pipeline-builder/pipeline-data';
import { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { CoreConstants } from '../config/app-config';

/**
 * Structured logger for Lambda (outputs JSON to CloudWatch).
 * Debug messages only emitted when LOG_LEVEL=debug.
 */
function logEntry(level: string, tag: string, message: string, data?: unknown) {
  const line = JSON.stringify({ level, tag, message, data, ts: new Date().toISOString() });
  switch (level) {
    case 'ERROR': console.error(line); break;
    case 'DEBUG': if (process.env.LOG_LEVEL === 'debug') console.debug(line); break;
    default: console.log(line);
  }
}

const lambdaLog = {
  info: (tag: string, message: string, data?: unknown) => logEntry('INFO', tag, message, data),
  error: (tag: string, message: string, data?: unknown) => logEntry('ERROR', tag, message, data),
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

/** Cached token to avoid repeated Secrets Manager calls within a single invocation. */
let cachedToken: string | null = null;

/** @internal Reset cached token (for testing only). */
export function _resetCredentialsCache(): void { cachedToken = null; }

/**
 * Fetch JWT token from AWS Secrets Manager.
 * Caches the result for the lifetime of the Lambda execution context.
 *
 * The secret name is set via PLATFORM_SECRET_NAME env var (e.g. `{prefix}/{orgId}/platform`)
 * Create it with: `pipeline-manager store-token`
 */
async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  lambdaLog.info('AUTH', `Fetching token from Secrets Manager: ${PLATFORM_SECRET_NAME}`);

  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: PLATFORM_SECRET_NAME }));

  if (!response.SecretString) {
    throw new Error(`Secret "${PLATFORM_SECRET_NAME}" is empty`);
  }

  const parsed = JSON.parse(response.SecretString) as Record<string, string>;
  // Schema is `{ username, password, ... }` — the `password` field is the
  // platform JWT. Same secret is read by CodeBuild's `secretsManagerCredentials`
  // for registry pulls (Basic auth: username:password = orgId:JWT). The
  // pipeline-image-registry token endpoint validates the password as a JWT
  // and issues a registry token scoped to the JWT's org.
  if (!parsed.password) {
    throw new Error(`Secret "${PLATFORM_SECRET_NAME}" missing password — run "pipeline-manager store-token" to generate`);
  }

  cachedToken = parsed.password;
  lambdaLog.info('AUTH', 'Token retrieved from Secrets Manager');
  return cachedToken;
}

/**
 * Creates a pre-configured Axios instance for API requests.
 *
 * @param baseURL - Base URL of the target API
 * @param token - JWT token for authorization
 * @returns Configured Axios instance
 */
function create(baseURL: string, token: string): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: CoreConstants.HANDLER_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
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

  for (let attempt = 0; attempt <= CoreConstants.HANDLER_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = CoreConstants.HANDLER_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      lambdaLog.info('RETRY', `Attempt ${attempt + 1}/${CoreConstants.HANDLER_MAX_RETRIES + 1} after ${delay}ms`);
      await sleep(delay);
    }

    try {
      const { data, status } = await api.post<Plugin>('/api/plugins/lookup', {
        filter: pluginFilter,
      });

      if (!data) {
        throw new Error('Empty response data from API');
      }

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
          lambdaLog.error('FETCH', `Plugin lookup timed out after ${CoreConstants.HANDLER_TIMEOUT_MS}ms`);
          throw new Error(`Plugin lookup timed out after ${CoreConstants.HANDLER_TIMEOUT_MS}ms`);
        }

        const retryable = error.response
          ? RETRYABLE_STATUSES.has(error.response.status)
          : RETRYABLE_CODES.has(error.code ?? '');

        const msg = error.response
          ? `API error ${error.response.status}: ${error.response.statusText}`
          : error.code || error.message;

        if (retryable && attempt < CoreConstants.HANDLER_MAX_RETRIES) {
          lambdaLog.info('RETRY', `Retryable error: ${msg}`, { attempt: attempt + 1 });
          lastError = new Error(`Failed to fetch plugin: ${msg}`);
          continue;
        }

        lambdaLog.error('FETCH', msg, { responseData: error.response?.data });
        throw new Error(`Failed to fetch plugin: ${msg}`);
      }

      throw error instanceof Error ? error : new Error('Unknown error during plugin fetch');
    }
  }

  throw lastError ?? new Error('Failed to fetch plugin after retries');
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
 * Authenticates using JWT token from AWS Secrets Manager (PLATFORM_SECRET_NAME env var).
 * Create the secret with: `pipeline-manager store-token`
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
  lambdaLog.info('START', `${event.RequestType} request received`, {
    logicalResourceId: event.LogicalResourceId,
    requestId: event.RequestId,
    stackId: event.StackId,
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
    const baseURL = event.ResourceProperties.baseURL || CoreConstants.HANDLER_DEFAULT_BASE_URL;

    if (!baseURL.startsWith('https://') && !baseURL.startsWith('http://')) {
      throw new Error(`Invalid baseURL: "${baseURL}" — must start with http:// or https://`);
    }

    lambdaLog.info('CONFIG', 'Configuration loaded', { baseURL, pluginFilter });

    validatePluginFilter(pluginFilter);

    // Get token from Secrets Manager and create API client
    const token = await getToken();
    const api = create(baseURL, token);

    // Fetch plugin
    lambdaLog.info('FETCH', 'Initiating plugin lookup...');
    const plugin = await fetch(api, pluginFilter);
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
      imageTag: plugin.imageTag,
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
