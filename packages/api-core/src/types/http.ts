/**
 * @module types/http
 * @description Framework-agnostic HTTP type definitions for api-core utilities.
 *
 * These types allow api-core to remain independent of Express or any specific framework.
 */

/**
 * Generic HTTP headers representation.
 */
export interface HttpHeaders {
  [key: string]: string | string[] | undefined;
}

/**
 * Generic HTTP request interface.
 * Represents the minimal request shape needed by api-core utilities.
 */
export interface HttpRequest {
  /** Request headers */
  headers: HttpHeaders;
  /** Route parameters */
  params: Record<string, string | string[] | undefined>;
  /** Query parameters */
  query: Record<string, unknown>;
  /** Authenticated user (if present) */
  user?: {
    organizationId?: string;
    userId?: string;
    role?: string;
    [key: string]: unknown;
  };
}

/**
 * Generic HTTP response interface.
 * Represents the minimal response shape needed by api-core utilities.
 */
export interface HttpResponse {
  /** Set HTTP status code */
  status(code: number): HttpResponse;
  /** Send JSON response */
  json(body: unknown): void;
  /** Set response header */
  setHeader(name: string, value: string | number): void;
}

/**
 * HTTP status codes.
 */
export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;
