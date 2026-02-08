import { PluginFilter, Plugin } from '@mwashburn160/pipeline-data';
import { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { CoreConstants } from '../config/app-config';

/**
 * Simple structured logger for Lambda (outputs to CloudWatch)
 * Note: We use console.* directly in Lambda handlers as it integrates
 * with CloudWatch Logs. The core logger is for the main application.
 */
const lambdaLog = {
  info: (tag: string, message: string, data?: unknown) => {
    console.log(JSON.stringify({ level: 'INFO', tag, message, data, ts: new Date().toISOString() }));
  },
  error: (tag: string, message: string, data?: unknown) => {
    console.error(JSON.stringify({ level: 'ERROR', tag, message, data, ts: new Date().toISOString() }));
  },
  debug: (tag: string, message: string, data?: unknown) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(JSON.stringify({ level: 'DEBUG', tag, message, data, ts: new Date().toISOString() }));
    }
  },
};

/**
 * Creates a pre-configured Axios instance for API requests.
 *
 * @param baseURL - Base URL of the target API
 * @returns Configured Axios instance
 */
function create(baseURL: string): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: CoreConstants.HANDLER_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Fetches plugin configuration from the external API.
 *
 * @param api - Configured Axios instance
 * @param pluginFilter - Filter criteria for the plugin lookup
 * @returns The plugin data returned by the API
 * @throws Error on network failure, timeout or invalid response
 */
async function fetch(api: AxiosInstance, pluginFilter: PluginFilter): Promise<Plugin> {
  lambdaLog.debug('FETCH', 'Starting plugin fetch', { filter: pluginFilter });

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
      const msg = error.response
        ? `API error ${error.response.status}: ${error.response.statusText}`
        : error.code || error.message;

      lambdaLog.error('FETCH', msg, { responseData: error.response?.data });

      throw new Error(`Failed to fetch plugin: ${msg}`);
    }

    throw error instanceof Error ? error : new Error('Unknown error during plugin fetch');
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
  if (!pluginFilter || typeof pluginFilter !== 'object' || pluginFilter === null) {
    throw new Error('Missing or invalid pluginFilter');
  }

  const filter = pluginFilter as Record<string, unknown>;

  // At least one filter criterion must be present
  if (!filter.name && !filter.id && !filter.version && !filter.orgId) {
    throw new Error('PluginFilter must have at least one criterion (name, id, version, or orgId)');
  }

  return true;
}

/**
 * Lambda handler for CloudFormation Custom Resource that performs plugin lookup.
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

    lambdaLog.info('CONFIG', 'Configuration loaded', { baseURL, pluginFilter });

    // Validate filter
    validatePluginFilter(pluginFilter);

    // Create API client
    const api = create(baseURL);

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