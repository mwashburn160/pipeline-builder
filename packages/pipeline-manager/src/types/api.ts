/**
 * API client type definitions.
 *
 * Provides shared types used by the {@link ApiClient} for making
 * HTTP requests to the platform API.
 *
 * Note: Unused interfaces (HttpClient, RequestConfig, ApiClientConfig,
 * TokenInfo, UploadProgress, PaginatedResponse, ApiResponse, ApiErrorResponse)
 * were removed during cleanup. Re-add as needed.
 *
 * @module types/api
 */

/**
 * Supported HTTP methods for API requests.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Key-value map of query string parameters appended to API request URLs.
 * Values of `null` or `undefined` are omitted from the serialized query string.
 */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;
