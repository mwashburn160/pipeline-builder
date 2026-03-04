/**
 * Supported HTTP methods for API requests.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Key-value map of query string parameters appended to API request URLs.
 * Values of `null` or `undefined` are omitted from the serialized query string.
 */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;
