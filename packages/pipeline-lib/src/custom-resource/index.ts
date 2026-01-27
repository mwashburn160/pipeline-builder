import { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { PluginFilter } from '../db/props-filters';
import { Plugin } from '../db/schema';
import { CoreConstants } from '../pipeline/appconfig';

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
  console.log('[FETCH] Filter:', JSON.stringify(pluginFilter, null, 2));

  try {
    const { data, status } = await api.post<Plugin>('/api/plugins/lookup', {
      filter: pluginFilter,
    });

    if (!data) {
      throw new Error('Empty response data from API');
    }

    console.log(`[FETCH] Success - Status: ${status}`);
    console.log(`[FETCH] Plugin: ${data.name} (${data.version}) - ID: ${data.id}`);

    return data;
  } catch (error) {
    if (error instanceof AxiosError) {
      const msg = error.response
        ? `API error ${error.response.status}: ${error.response.statusText}`
        : error.code || error.message;

      console.error('[FETCH] Error:', msg);

      if (error.response?.data) {
        console.error('[FETCH] Response data:', error.response.data);
      }

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
  console.log(`[START] ${event.RequestType} - LogicalResourceId: ${event.LogicalResourceId}`);
  console.log(`[START] RequestId: ${event.RequestId}`);
  console.log(`[START] StackId: ${event.StackId}`);

  const baseResponse: Partial<CloudFormationCustomResourceResponse> = {
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    PhysicalResourceId: event.LogicalResourceId,
  };

  try {
    // Handle Delete - always succeed (no-op)
    if (event.RequestType === 'Delete') {
      console.log('[DELETE] No-op - returning SUCCESS');
      return {
        ...baseResponse,
        Status: 'SUCCESS',
        Reason: 'Delete completed (no-op)',
      } as CloudFormationCustomResourceResponse;
    }

    // Extract and validate properties
    const pluginFilter = event.ResourceProperties.pluginFilter;
    const baseURL = event.ResourceProperties.baseURL || CoreConstants.HANDLER_DEFAULT_BASE_URL;

    console.log('[CONFIG] Using baseURL:', baseURL);
    console.log('[CONFIG] PluginFilter:', JSON.stringify(pluginFilter, null, 2));

    // Validate filter
    validatePluginFilter(pluginFilter);

    // Create API client
    const api = create(baseURL);

    // Fetch plugin
    console.log('[FETCH] Initiating plugin lookup...');
    const plugin = await fetch(api, pluginFilter as PluginFilter);
    console.log('[FETCH] Completed successfully');
    console.log(`[FETCH] Plugin: ${plugin.name} v${plugin.version} (ID: ${plugin.id})`);

    // Encode response
    const encoded = Buffer.from(JSON.stringify(plugin), 'utf-8').toString('base64');
    console.log(`[ENCODE] Encoded plugin data (${encoded.length} chars)`);

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
    console.error('[ERROR] Handler failed:', reason);

    if (error instanceof Error && error.stack) {
      console.error('[ERROR] Stack trace:', error.stack);
    }

    return {
      ...baseResponse,
      Status: 'FAILED',
      Reason: reason,
    } as CloudFormationCustomResourceResponse;
  } finally {
    console.log('[END] Custom resource execution completed');
  }
};