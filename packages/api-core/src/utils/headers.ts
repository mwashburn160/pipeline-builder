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
