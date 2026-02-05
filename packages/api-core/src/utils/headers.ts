/**
 * @module utils/headers
 * @description Utilities for handling Express 5 headers.
 *
 * In Express 5, headers can be `string | string[] | undefined`.
 * These utilities provide type-safe header extraction.
 */

/**
 * Express 5 header type.
 */
type HeaderValue = string | string[] | undefined;

/**
 * Extract a single string from a header value that may be string | string[] | undefined.
 *
 * @param value - Header value from Express request
 * @returns First value if array, the value if string, or undefined
 *
 * @example
 * ```typescript
 * const orgId = getHeaderString(req.headers['x-org-id']);
 * const auth = getHeaderString(req.headers.authorization);
 * ```
 */
export function getHeaderString(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Extract a required header value, throwing an error if missing.
 *
 * @param value - Header value from Express request
 * @param headerName - Name of the header (for error messages)
 * @returns The header value as a string
 * @throws Error if header is missing or empty
 *
 * @example
 * ```typescript
 * try {
 *   const auth = getRequiredHeader(req.headers.authorization, 'Authorization');
 *   // auth is guaranteed to be a non-empty string
 * } catch (err) {
 *   return sendError(res, 400, err.message);
 * }
 * ```
 */
export function getRequiredHeader(value: HeaderValue, headerName: string): string {
  const header = getHeaderString(value);
  if (!header || header === '') {
    throw new Error(`Missing required header: ${headerName}`);
  }
  return header;
}

/**
 * Extract multiple headers from Express request.
 *
 * @param headers - Request headers object
 * @param keys - Array of header keys to extract
 * @returns Object with header values
 *
 * @example
 * ```typescript
 * const { authorization, 'x-org-id': orgId } = getHeaders(req.headers, ['authorization', 'x-org-id']);
 * ```
 */
export function getHeaders<K extends string>(
  headers: Record<string, HeaderValue>,
  keys: K[],
): Record<K, string | undefined> {
  const result = {} as Record<K, string | undefined>;
  for (const key of keys) {
    result[key] = getHeaderString(headers[key]);
  }
  return result;
}
