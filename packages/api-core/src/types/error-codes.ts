// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
  TOKEN_REVOKED = 'TOKEN_REVOKED',
  /** The session is not MFA-grade (`aal` below the route's `minAssurance`).
   *  The client sends the person to enrol / sign in again with a second
   *  factor — it must NOT sign them out or retry a token refresh, since a
   *  refresh can never raise the assurance level. */
  MFA_REQUIRED = 'MFA_REQUIRED',
  /** The session is MFA-grade but its `auth_time` is older than the route's
   *  `maxAge` — the person must authenticate again (not merely refresh). */
  REAUTH_REQUIRED = 'REAUTH_REQUIRED',

  // Authorization errors (403)
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  /** A machine credential (service principal, org service account, or an
   *  exchanged access key) reached a route that requires a person. */
  HUMAN_SESSION_REQUIRED = 'HUMAN_SESSION_REQUIRED',
  /** A bootstrap-admin enrolment session (`mfaEnrollmentPending`) reached a
   *  route outside the enrolment / sign-out / setup allowlist. */
  MFA_ENROLLMENT_REQUIRED = 'MFA_ENROLLMENT_REQUIRED',
  ORG_MISMATCH = 'ORG_MISMATCH',
  COMPLIANCE_VIOLATION = 'COMPLIANCE_VIOLATION',

  // Not found errors (404)
  NOT_FOUND = 'NOT_FOUND',
  ORG_NOT_FOUND = 'ORG_NOT_FOUND',

  // Validation errors (400)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  TEMPLATE_UNKNOWN_PATH = 'TEMPLATE_UNKNOWN_PATH',
  TEMPLATE_CYCLE = 'TEMPLATE_CYCLE',
  TEMPLATE_PARSE_ERROR = 'TEMPLATE_PARSE_ERROR',
  TEMPLATE_TYPE_MISMATCH = 'TEMPLATE_TYPE_MISMATCH',
  TEMPLATE_SECRETS_RESERVED = 'TEMPLATE_SECRETS_RESERVED',
  TEMPLATE_CONTRACT_VIOLATION = 'TEMPLATE_CONTRACT_VIOLATION',
  TEMPLATE_SIZE_EXCEEDED = 'TEMPLATE_SIZE_EXCEEDED',
  TEMPLATE_VALIDATION_FAILED = 'TEMPLATE_VALIDATION_FAILED',

  // Quota/Rate limit errors (429)
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // Payload errors (413)
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',

  // Conflict errors (409)
  CONFLICT = 'CONFLICT',
  DUPLICATE_ENTRY = 'DUPLICATE_ENTRY',
  SCAN_CONFLICT = 'SCAN_CONFLICT',
  /** A plugin image's cosign signature (or its signed SBOM attestation) did
   *  not verify against the platform's plugin-signing key — the registry
   *  content no longer matches what the platform built and signed. */
  IMAGE_VERIFICATION_FAILED = 'IMAGE_VERIFICATION_FAILED',

  // Billing errors
  PAYMENT_METHOD_REQUIRED = 'PAYMENT_METHOD_REQUIRED', // 402
  DISCOUNT_CEILING_EXCEEDED = 'DISCOUNT_CEILING_EXCEEDED', // 400
  DISCOUNT_NOT_FOUND = 'DISCOUNT_NOT_FOUND', // 404
  DISCOUNT_INACTIVE = 'DISCOUNT_INACTIVE', // 409
  PLAN_OVER_CAP = 'PLAN_OVER_CAP', // 409
  ADDON_OVER_CAP = 'ADDON_OVER_CAP', // 409

  // Server errors (500)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',

  // Not implemented (501) — the configured provider has no such capability
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',

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
  [ErrorCode.TOKEN_REVOKED]: 401,
  [ErrorCode.MFA_REQUIRED]: 401,
  [ErrorCode.REAUTH_REQUIRED]: 401,
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: 403,
  [ErrorCode.HUMAN_SESSION_REQUIRED]: 403,
  [ErrorCode.MFA_ENROLLMENT_REQUIRED]: 403,
  [ErrorCode.ORG_MISMATCH]: 403,
  [ErrorCode.COMPLIANCE_VIOLATION]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.ORG_NOT_FOUND]: 404,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.MISSING_REQUIRED_FIELD]: 400,
  [ErrorCode.TEMPLATE_UNKNOWN_PATH]: 400,
  [ErrorCode.TEMPLATE_CYCLE]: 400,
  [ErrorCode.TEMPLATE_PARSE_ERROR]: 400,
  [ErrorCode.TEMPLATE_TYPE_MISMATCH]: 400,
  [ErrorCode.TEMPLATE_SECRETS_RESERVED]: 400,
  [ErrorCode.TEMPLATE_CONTRACT_VIOLATION]: 400,
  [ErrorCode.TEMPLATE_SIZE_EXCEEDED]: 400,
  [ErrorCode.TEMPLATE_VALIDATION_FAILED]: 400,
  [ErrorCode.QUOTA_EXCEEDED]: 429,
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.DUPLICATE_ENTRY]: 409,
  [ErrorCode.SCAN_CONFLICT]: 409,
  [ErrorCode.IMAGE_VERIFICATION_FAILED]: 409,
  [ErrorCode.PAYMENT_METHOD_REQUIRED]: 402,
  [ErrorCode.DISCOUNT_CEILING_EXCEEDED]: 400,
  [ErrorCode.DISCOUNT_NOT_FOUND]: 404,
  [ErrorCode.DISCOUNT_INACTIVE]: 409,
  [ErrorCode.PLAN_OVER_CAP]: 409,
  [ErrorCode.ADDON_OVER_CAP]: 409,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.DATABASE_ERROR]: 500,
  [ErrorCode.NOT_IMPLEMENTED]: 501,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE]: 503,
};

/**
 * Get the HTTP status code for an error code.
 */
export function getStatusForErrorCode(code: ErrorCode): number {
  return ErrorCodeStatus[code] ?? 500;
}
