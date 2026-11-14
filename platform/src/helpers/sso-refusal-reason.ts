// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stable label a federated-sign-in refusal is recorded under, for the audit
 * record and the metric.
 *
 * ONE keyed catalog, replacing two hand-written switches that had drifted
 * apart. `refusalReason` in controllers/saml.ts knew 16 codes; `reasonOf` in
 * helpers/sso-test-flow.ts knew a different 16; they shared only 9. A code
 * missing from one fell through to the generic `error` there while the other
 * labelled it correctly — so the same refusal reported two different shapes
 * depending on which path saw it, in the metric whose stated job is to make
 * "this connection has quietly stopped working" visible as a shape rather than
 * as user complaints.
 *
 * WHY THIS IS ITS OWN TABLE and not a `reason` field on `SAML_ERROR_MAP` /
 * `OIDC_ERROR_MAP`, which is where it was first put. Those maps live in service
 * modules, and the suites that exercise the refusal paths STUB those services —
 * so a label derived from them vanished under test and every refusal reported
 * `error`. Six existing assertions caught it. A label the controller needs must
 * not depend on whether the service module happens to be real, so the catalog
 * is pure data with no imports, and `sso-refusal-reason.test.ts` ties it back to
 * the two error maps by key instead.
 */

/** What an unrecognised or deliberately unlabelled code reports. */
export const UNLABELLED_REFUSAL_REASON = 'error';

/**
 * code -> the label it is recorded under.
 *
 * SAML and OIDC twins share a label on purpose: the same refusal should read
 * the same whichever protocol produced it. Four of these OIDC entries
 * (NOT_CONFIGURED, DISABLED, NOT_ENTITLED, PROTOCOL_MISMATCH) had no label at
 * all before, so an OIDC connection that was merely unconfigured was
 * indistinguishable from a crash while the identical SAML refusal was legible.
 */
const REASON_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  // Configuration and entitlement — the refusals an admin fixes.
  SAML_NOT_CONFIGURED: 'not_configured',
  OIDC_NOT_CONFIGURED: 'not_configured',
  SAML_DISABLED: 'disabled',
  OIDC_DISABLED: 'disabled',
  SAML_NOT_ENTITLED: 'not_entitled',
  OIDC_NOT_ENTITLED: 'not_entitled',
  SAML_PROTOCOL_MISMATCH: 'protocol_mismatch',
  OIDC_PROTOCOL_MISMATCH: 'protocol_mismatch',
  SAML_INCOMPLETE_CONFIG: 'incomplete_config',
  OIDC_PROVIDER_UNSUPPORTED: 'provider_unsupported',

  // Protocol-level refusals.
  SAML_INVALID_STATE: 'invalid_state',
  OIDC_INVALID_STATE: 'invalid_state',
  SAML_IDP_INITIATED: 'idp_initiated',
  SAML_REPLAYED_ASSERTION: 'replay',
  SAML_INVALID_ASSERTION: 'invalid_assertion',
  SAML_ENCRYPTION_REQUIRED: 'encryption_required',
  SAML_UNEXPECTED_ENCRYPTION: 'unexpected_encryption',
  OIDC_INVALID_ID_TOKEN: 'invalid_id_token',
  OIDC_TOKEN_EXCHANGE_FAILED: 'token_exchange_failed',
  OIDC_DISCOVERY_FAILED: 'discovery_failed',

  // Identity refusals — the person, not the connection.
  SAML_NO_EMAIL: 'no_email',
  OIDC_NO_EMAIL: 'no_email',
  SAML_EMAIL_DOMAIN_NOT_ALLOWED: 'email_domain_not_allowed',
  OIDC_EMAIL_DOMAIN_NOT_ALLOWED: 'email_domain_not_allowed',
  OIDC_EMAIL_DOMAIN_NOT_VERIFIED: 'domain_not_verified',
  ACCOUNT_EMAIL_UNVERIFIED: 'account_email_unverified',
  JIT_SEAT_LIMIT: 'seat_limit',
  SSO_SUPERADMIN_REFUSED: 'platform_admin',

  // The provider's own error relayed through, not a refusal we raised — which
  // is why it sits in neither error map.
  IDP_ERROR: 'idp_error',
});

/**
 * Codes that are in an error map and deliberately carry NO label: they reach no
 * refusal path, so a label for them could never be emitted. Named here so the
 * drift test can tell "decided against" from "forgotten".
 */
export const UNLABELLED_BY_DESIGN: readonly string[] = Object.freeze([
  // Step-up re-auth declines SAML and says so to the user; it is not a
  // connection failure.
  'SAML_STEP_UP_UNSUPPORTED',
  // Single-logout and metadata handling are their own flows, not sign-in.
  'SAML_INVALID_LOGOUT',
  'SAML_SLO_NOT_CONFIGURED',
  'SAML_METADATA_INVALID',
]);

/**
 * The label for `code`, or {@link UNLABELLED_REFUSAL_REASON} when there is
 * none.
 */
export function ssoRefusalReason(code: string | undefined): string {
  return code !== undefined && Object.hasOwn(REASON_BY_CODE, code) ? REASON_BY_CODE[code] : UNLABELLED_REFUSAL_REASON;
}

/** Every code the catalog labels — for the drift test, and for operators. */
export function labelledRefusalCodes(): string[] {
  return Object.keys(REASON_BY_CODE).sort();
}
