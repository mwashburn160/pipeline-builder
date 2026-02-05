/**
 * @module types/error-codes
 * @description Standardized error codes for API responses.
 */

/**
 * Standardized error codes used across all API microservices.
 * Use these codes in error responses for consistent client handling.
 */
export enum ErrorCode {
  // Authentication errors (401)
  UNAUTHORIZED = 'UNAUTHORIZED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  TOKEN_MISSING = 'TOKEN_MISSING',

  // Authorization errors (403)
  FORBIDDEN = 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  ORG_MISMATCH = 'ORG_MISMATCH',

  // Not found errors (404)
  NOT_FOUND = 'NOT_FOUND',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  ORG_NOT_FOUND = 'ORG_NOT_FOUND',

  // Validation errors (400)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  INVALID_FORMAT = 'INVALID_FORMAT',

  // Quota/Rate limit errors (429)
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  PLUGINS_QUOTA_EXCEEDED = 'PLUGINS_QUOTA_EXCEEDED',
  PIPELINES_QUOTA_EXCEEDED = 'PIPELINES_QUOTA_EXCEEDED',
  API_CALLS_QUOTA_EXCEEDED = 'API_CALLS_QUOTA_EXCEEDED',

  // Conflict errors (409)
  CONFLICT = 'CONFLICT',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  DUPLICATE_ENTRY = 'DUPLICATE_ENTRY',

  // Server errors (500)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
}

/**
 * Maps error codes to their default HTTP status codes.
 */
export const ErrorCodeStatus: Record<ErrorCode, number> = {
  // 401
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.TOKEN_INVALID]: 401,
  [ErrorCode.TOKEN_MISSING]: 401,

  // 403
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: 403,
  [ErrorCode.ORG_MISMATCH]: 403,

  // 404
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.RESOURCE_NOT_FOUND]: 404,
  [ErrorCode.ORG_NOT_FOUND]: 404,

  // 400
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.INVALID_INPUT]: 400,
  [ErrorCode.MISSING_REQUIRED_FIELD]: 400,
  [ErrorCode.INVALID_FORMAT]: 400,

  // 429
  [ErrorCode.QUOTA_EXCEEDED]: 429,
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCode.PLUGINS_QUOTA_EXCEEDED]: 429,
  [ErrorCode.PIPELINES_QUOTA_EXCEEDED]: 429,
  [ErrorCode.API_CALLS_QUOTA_EXCEEDED]: 429,

  // 409
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.ALREADY_EXISTS]: 409,
  [ErrorCode.DUPLICATE_ENTRY]: 409,

  // 500
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.DATABASE_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: 502,
};

/**
 * Get the HTTP status code for an error code.
 *
 * @param code - Error code
 * @returns Corresponding HTTP status code (defaults to 500)
 *
 * @example
 * ```typescript
 * const status = getStatusForErrorCode(ErrorCode.UNAUTHORIZED); // 401
 * ```
 */
export function getStatusForErrorCode(code: ErrorCode): number {
  return ErrorCodeStatus[code] ?? 500;
}
