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
  /** A read-only impersonation token (`impersonationReadOnly`) attempted a
   *  state-changing request (anything but GET/HEAD/OPTIONS). */
  IMPERSONATION_READ_ONLY = 'IMPERSONATION_READ_ONLY',
  /** A plugin-ecosystem governance route (docs/plans/plugin-ecosystem.md §3.0)
   *  was called from an active org other than the system org — a token minted in
   *  a tenant org is refused even for the same user. Switch to the system org. */
  SYSTEM_ORG_REQUIRED = 'SYSTEM_ORG_REQUIRED',
  /** The publisher hasn't accepted the CURRENT publisher terms version, so it
   *  can't submit new requests (existing listings are unaffected, §3.1). */
  PUBLISHER_TERMS_REQUIRED = 'PUBLISHER_TERMS_REQUIRED',
  /** Publishing is done from the ROOT org; a team org can't own a publisher or
   *  submit requests (§3.1, G33). */
  PUBLISHER_ROOT_ORG_REQUIRED = 'PUBLISHER_ROOT_ORG_REQUIRED',
  /** The publisher is suspended by the system org (§3.6). */
  PUBLISHER_SUSPENDED = 'PUBLISHER_SUSPENDED',
  /** Tenant publishing is switched off on this instance (`PLUGIN_PUBLISHING_ENABLED`, §9). */
  PLUGIN_PUBLISHING_DISABLED = 'PLUGIN_PUBLISHING_DISABLED',
  /** Review writes are switched off on this instance (`PLUGIN_REVIEWS_ENABLED`,
   *  §9): reviews stay readable, nothing new is written. */
  PLUGIN_REVIEWS_DISABLED = 'PLUGIN_REVIEWS_DISABLED',
  /** A member of the publisher's own organization tried to review (or vote on a
   *  review of) one of its listings (§5 G16, self-promotion). */
  REVIEW_SELF_PROMOTION = 'REVIEW_SELF_PROMOTION',
  /** Separation of duties (§3.0.1): the caller may not decide this request —
   *  it came from an org they belong to, they uploaded the version, or they
   *  gave the first of two approvals. */
  SEPARATION_OF_DUTIES = 'SEPARATION_OF_DUTIES',
  ORG_MISMATCH = 'ORG_MISMATCH',
  COMPLIANCE_VIOLATION = 'COMPLIANCE_VIOLATION',

  // Not found errors (404)
  NOT_FOUND = 'NOT_FOUND',
  ORG_NOT_FOUND = 'ORG_NOT_FOUND',
  /** The anonymous plugin submission API is off on this instance
   *  (`ANONYMOUS_SUBMISSIONS_ENABLED`, or outbound email isn't configured) —
   *  answered as a plain 404 (docs/plans/plugin-ecosystem.md §4). */
  SUBMISSIONS_DISABLED = 'SUBMISSIONS_DISABLED',

  // Validation errors (400)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  /** A proof-of-work answer is missing, malformed, expired, too easy, wrong,
   *  or was already used (anonymous submissions, §4.2). */
  PROOF_OF_WORK_INVALID = 'PROOF_OF_WORK_INVALID',
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
  /** An anonymous submitter (per verified email, or per client IP) is at the
   *  rolling 24-hour submission cap (§4.2). */
  SUBMISSION_LIMIT = 'SUBMISSION_LIMIT',

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
  /** The plugin version is immutable — a publish request references it
   *  (`frozen_at` set) or it is published to a listing — so it can be neither
   *  re-uploaded, edited nor deleted (docs/plans/plugin-ecosystem.md §3.4). */
  PLUGIN_VERSION_FROZEN = 'PLUGIN_VERSION_FROZEN',
  /** The plugin version is referenced by one of the org's pipelines, or published
   *  to an ecosystem listing; deleting it needs `?force=true` plus a step-up. */
  PLUGIN_VERSION_IN_USE = 'PLUGIN_VERSION_IN_USE',
  /** A freeze named an image digest that is not the version's stored digest
   *  (fail closed: what was requested is not what would be published). */
  PLUGIN_DIGEST_MISMATCH = 'PLUGIN_DIGEST_MISMATCH',
  /** A publish request needs the org's publisher profile, which doesn't exist
   *  yet (docs/plans/plugin-ecosystem.md §3.1). Claim a handle first. */
  PUBLISHER_REQUIRED = 'PUBLISHER_REQUIRED',
  /** The requested publisher handle is reserved (Official/Verified
   *  reservations, confusables). Submit a `claim` request instead. */
  PUBLISHER_HANDLE_RESERVED = 'PUBLISHER_HANDLE_RESERVED',
  /** A publish request failed a submit gate (public visibility, SPDX license,
   *  README, signature, scan, vulnerability gate …); `details.gates` lists them. */
  PUBLISH_GATE_FAILED = 'PUBLISH_GATE_FAILED',
  /** A Verified-publisher application (or its decision) from an org whose plan
   *  lacks the `verified_publisher` feature (Team+, docs/plans/plugin-ecosystem.md §3.7). */
  VERIFIED_PLAN_REQUIRED = 'VERIFIED_PLAN_REQUIRED',
  /** A Verified-publisher application from an org with no DNS-verified domain. */
  VERIFIED_DOMAIN_REQUIRED = 'VERIFIED_DOMAIN_REQUIRED',
  /** A Verified-publisher application from an org whose owner has no second
   *  factor (passkey or authenticator app). */
  VERIFIED_OWNER_MFA_REQUIRED = 'VERIFIED_OWNER_MFA_REQUIRED',
  /** A plugin reference names an ecosystem listing the org hasn't installed (or
   *  whose install is pending, denied, or doesn't cover the version asked for;
   *  `details.reason`) — docs/plans/plugin-ecosystem.md §3.2, §3.5. */
  PLUGIN_NOT_INSTALLED = 'PLUGIN_NOT_INSTALLED',
  /** The org's consumption policy refuses the listing: its tier isn't allowed,
   *  the listing is blocked, or an advisory blocks the version (`details.reason`). */
  PLUGIN_BLOCKED_BY_POLICY = 'PLUGIN_BLOCKED_BY_POLICY',
  /** The listing or version can't be used: yanked, suspended, or paused for new
   *  installs (`details.reason`). */
  PLUGIN_UNAVAILABLE = 'PLUGIN_UNAVAILABLE',
  /** An auto-created placeholder plugin can't take the name of a listed plugin
   *  (G17) — install the listing instead. */
  PLUGIN_NAME_LISTED = 'PLUGIN_NAME_LISTED',
  /** An anonymous submission names a community listing another submitter owns,
   *  a reserved name, an Official/Verified listing's name, or one confusable
   *  with a top listing (§4.2 "Names"); `details.reason` says which. */
  NAME_TAKEN = 'NAME_TAKEN',

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
  [ErrorCode.SYSTEM_ORG_REQUIRED]: 403,
  [ErrorCode.PUBLISHER_TERMS_REQUIRED]: 403,
  [ErrorCode.PUBLISHER_ROOT_ORG_REQUIRED]: 403,
  [ErrorCode.PUBLISHER_SUSPENDED]: 403,
  [ErrorCode.PLUGIN_PUBLISHING_DISABLED]: 403,
  [ErrorCode.PLUGIN_REVIEWS_DISABLED]: 403,
  [ErrorCode.REVIEW_SELF_PROMOTION]: 403,
  [ErrorCode.SEPARATION_OF_DUTIES]: 403,
  [ErrorCode.HUMAN_SESSION_REQUIRED]: 403,
  [ErrorCode.MFA_ENROLLMENT_REQUIRED]: 403,
  [ErrorCode.IMPERSONATION_READ_ONLY]: 403,
  [ErrorCode.ORG_MISMATCH]: 403,
  [ErrorCode.COMPLIANCE_VIOLATION]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.ORG_NOT_FOUND]: 404,
  [ErrorCode.SUBMISSIONS_DISABLED]: 404,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.MISSING_REQUIRED_FIELD]: 400,
  [ErrorCode.PROOF_OF_WORK_INVALID]: 400,
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
  [ErrorCode.SUBMISSION_LIMIT]: 429,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.DUPLICATE_ENTRY]: 409,
  [ErrorCode.SCAN_CONFLICT]: 409,
  [ErrorCode.IMAGE_VERIFICATION_FAILED]: 409,
  [ErrorCode.PLUGIN_VERSION_FROZEN]: 409,
  [ErrorCode.PLUGIN_VERSION_IN_USE]: 409,
  [ErrorCode.PLUGIN_DIGEST_MISMATCH]: 409,
  [ErrorCode.PUBLISHER_REQUIRED]: 409,
  [ErrorCode.PUBLISHER_HANDLE_RESERVED]: 409,
  [ErrorCode.PUBLISH_GATE_FAILED]: 409,
  [ErrorCode.VERIFIED_PLAN_REQUIRED]: 403,
  [ErrorCode.VERIFIED_DOMAIN_REQUIRED]: 409,
  [ErrorCode.VERIFIED_OWNER_MFA_REQUIRED]: 409,
  [ErrorCode.PLUGIN_NOT_INSTALLED]: 403,
  [ErrorCode.PLUGIN_BLOCKED_BY_POLICY]: 403,
  [ErrorCode.PLUGIN_UNAVAILABLE]: 409,
  [ErrorCode.PLUGIN_NAME_LISTED]: 409,
  [ErrorCode.NAME_TAKEN]: 409,
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
