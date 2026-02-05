/**
 * API client type definitions
 *
 * Note: Unused interfaces (HttpClient, RequestConfig, ApiClientConfig,
 * TokenInfo, UploadProgress, PaginatedResponse, ApiResponse, ApiErrorResponse)
 * were removed during cleanup. Re-add as needed.
 */

/**
 * HTTP methods
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Query parameters
 */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;
