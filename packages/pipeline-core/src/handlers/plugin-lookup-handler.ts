import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PluginFilter, Plugin } from '@mwashburn160/pipeline-data';
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

/** Service credentials secret following the standard {prefix}/{orgId}/{secretName} pattern. */
const CREDENTIALS_SECRET_NAME = `${CoreConstants.SECRETS_PATH_PREFIX}/system/credentials`;

/** Cached credentials to avoid repeated Secrets Manager calls within a single invocation. */
let cachedCredentials: { email: string; password: string } | null = null;

/** @internal Reset cached credentials (for testing only). */
export function _resetCredentialsCache(): void { cachedCredentials = null; }

/**
 * Fetch service credentials from AWS Secrets Manager using the standard secret name.
 * Caches the result for the lifetime of the Lambda execution context.
 *
 * The secret is expected at: `{SECRETS_PATH_PREFIX}/system/credentials`
 * Create it with: `pipeline-manager store-credentials`
 */
async function getCredentials(): Promise<{ email: string; password: string }> {
  if (cachedCredentials) return cachedCredentials;

  lambdaLog.info('AUTH', `Fetching credentials from Secrets Manager: ${CREDENTIALS_SECRET_NAME}`);

  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: CREDENTIALS_SECRET_NAME }));

  if (!response.SecretString) {
    throw new Error(`Credentials secret "${CREDENTIALS_SECRET_NAME}" is empty`);
  }

  const parsed = JSON.parse(response.SecretString) as { email?: string; password?: string };
  if (!parsed.email || !parsed.password) {
    throw new Error(`Credentials secret "${CREDENTIALS_SECRET_NAME}" missing email or password fields`);
  }

  cachedCredentials = { email: parsed.email, password: parsed.password };
  return cachedCredentials;
}

/**
 * Authenticates with the platform API using service credentials from Secrets Manager
 * and returns a fresh JWT.
 *
 * @param baseURL - Base URL of the target API
 * @returns Fresh JWT token
 * @throws Error if authentication fails or no credentials are available
 */
async function authenticate(baseURL: string): Promise<string> {
  const { email, password } = await getCredentials();

  lambdaLog.info('AUTH', 'Authenticating with service credentials');
  try {
    const { data } = await axios.post(`${baseURL}/api/auth/login`, {
      email,
      password,
    }, {
      timeout: CoreConstants.HANDLER_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!data?.token) {
      throw new Error('Login response missing token');
    }

    lambdaLog.info('AUTH', 'Authentication successful');
    return data.token;
  } catch (error) {
    const msg = error instanceof AxiosError
      ? `${error.response?.status || error.code}: ${error.response?.statusText || error.message}`
      : error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Authentication failed: ${msg}`);
  }
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
 * Authenticates using service credentials stored in AWS Secrets Manager
 * at `{SECRETS_PATH_PREFIX}/system/credentials` (resolved by name).
 * Create the secret with: `pipeline-manager store-credentials`
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

    // Authenticate and create API client
    const token = await authenticate(baseURL);
    const api = create(baseURL, token);

    // Fetch plugin
    lambdaLog.info('FETCH', 'Initiating plugin lookup...');
    const plugin = await fetch(api, pluginFilter);
    lambdaLog.info('FETCH', 'Plugin retrieved successfully', {
      name: plugin.name,
      version: plugin.version,
      id: plugin.id,
    });

    // Encode response
    const encoded = Buffer.from(JSON.stringify(plugin), 'utf-8').toString('base64');
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
