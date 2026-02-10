/**
 * @module constants/http-status
 * @description HTTP status code constants for consistent usage across API microservices.
 */

/**
 * HTTP status codes organized by category.
 */
export const HttpStatus = {
  // Success 2xx
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,

  // Client Errors 4xx
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,

  // Server Errors 5xx
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

/**
 * Type for valid HTTP status codes.
 */
export type HttpStatusCode = (typeof HttpStatus)[keyof typeof HttpStatus];
