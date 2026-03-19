/**
 * Standardized error codes used across all API microservices.
 * Use these codes in error responses for consistent client handling.
 *
 * Each HTTP status category has one primary code. Use the `details`
 * field in error responses for sub-type information (e.g. which quota
 * was exceeded, which field failed validation).
 */
export enum ErrorCode {
  // Authentication errors (401)
  UNAUTHORIZED = 'UNAUTHORIZED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  TOKEN_MISSING = 'TOKEN_MISSING',

  // Authorization errors (403)
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  ORG_MISMATCH = 'ORG_MISMATCH',
  COMPLIANCE_VIOLATION = 'COMPLIANCE_VIOLATION',

  // Not found errors (404)
  NOT_FOUND = 'NOT_FOUND',
  ORG_NOT_FOUND = 'ORG_NOT_FOUND',

  // Validation errors (400)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',

  // Quota/Rate limit errors (429)
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // Conflict errors (409)
  CONFLICT = 'CONFLICT',
  DUPLICATE_ENTRY = 'DUPLICATE_ENTRY',
  SCAN_CONFLICT = 'SCAN_CONFLICT',

  // Server errors (500)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',

  // Service unavailable (503)
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  COMPLIANCE_SERVICE_UNAVAILABLE = 'COMPLIANCE_SERVICE_UNAVAILABLE',
}

/**
 * Maps error codes to their default HTTP status codes.
 */
export const ErrorCodeStatus: Record<ErrorCode, number> = {
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.TOKEN_INVALID]: 401,
  [ErrorCode.TOKEN_MISSING]: 401,
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: 403,
  [ErrorCode.ORG_MISMATCH]: 403,
  [ErrorCode.COMPLIANCE_VIOLATION]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.ORG_NOT_FOUND]: 404,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.MISSING_REQUIRED_FIELD]: 400,
  [ErrorCode.QUOTA_EXCEEDED]: 429,
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.DUPLICATE_ENTRY]: 409,
  [ErrorCode.SCAN_CONFLICT]: 409,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.DATABASE_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE]: 503,
};

/**
 * Get the HTTP status code for an error code.
 */
export function getStatusForErrorCode(code: ErrorCode): number {
  return ErrorCodeStatus[code] ?? 500;
}
