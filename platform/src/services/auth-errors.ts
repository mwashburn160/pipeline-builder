// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication, sign-up and social/SSO sign-in error codes.
 *
 * Thrown by the services and mapped to HTTP status in each controller's
 * `errorMap`. Dependency-free on purpose (see `org-errors.ts`): controllers and
 * tests import the codes without loading a service and its models/config.
 */

export const DUPLICATE_CREDENTIALS = 'DUPLICATE_CREDENTIALS';
/** A self-serve caller tried to create/join the reserved `system` org
 *  (name === SYSTEM_ORG_SLUG) without operator authorization. The system org
 *  confers platform superadmin to its creator, so only an operator-authorized
 *  email (BOOTSTRAP_SUPERADMIN_EMAILS) may create it; everyone else is refused. */
export const RESERVED_ORG_NAME = 'RESERVED_ORG_NAME';
/** `completeOnboarding` could not resolve the caller's user or their active org. */
export const ONBOARDING_USER_NOT_FOUND = 'ONBOARDING_USER_NOT_FOUND';
export const ONBOARDING_NO_ORG = 'ONBOARDING_NO_ORG';
/** Thrown by findOrCreateOAuthUser when a social/SSO login would silently link
 *  onto a pre-existing but UNVERIFIED account. Mapped to 409 by the OAuth + OIDC
 *  callback error maps (single source, shared by both). */
export const ACCOUNT_EMAIL_UNVERIFIED = 'ACCOUNT_EMAIL_UNVERIFIED';
/** A platform administrator's sign-in must never depend on a tenant-run IdP.
 *  Mapped to 403 in OIDC_ERROR_MAP. */
export const SSO_SUPERADMIN_REFUSED = 'SSO_SUPERADMIN_REFUSED';

// -- Social OAuth sign-in (controllers/oauth.ts OAUTH_ERROR_MAP) ---------------

/** No such social provider. → 400 */
export const OAUTH_UNSUPPORTED_PROVIDER = 'OAUTH_UNSUPPORTED_PROVIDER';
/** The provider exists but has no client configured. → 400 */
export const OAUTH_PROVIDER_DISABLED = 'OAUTH_PROVIDER_DISABLED';
/** The CSRF `state` is unknown, expired, replayed or minted for another provider. → 403 */
export const OAUTH_INVALID_STATE = 'OAUTH_INVALID_STATE';
/** The provider refused (or garbled) the authorization-code exchange. → 502 */
export const OAUTH_TOKEN_EXCHANGE_FAILED = 'OAUTH_TOKEN_EXCHANGE_FAILED';
/** The provider's user-info endpoint failed. → 502 */
export const OAUTH_USERINFO_FAILED = 'OAUTH_USERINFO_FAILED';
/** The provider returned no email (e.g. the user declined the email permission). → 400 */
export const OAUTH_NO_EMAIL = 'OAUTH_NO_EMAIL';
/** The provider returned an email it has not verified — never trusted for account linking. → 403 */
export const OAUTH_EMAIL_UNVERIFIED = 'OAUTH_EMAIL_UNVERIFIED';
/** Microsoft sign-in against a shared tenant (`common`/`organizations`/`consumers`),
 *  whose email claim is unverifiable (nOAuth). The operator must pin a tenant. → 400 */
export const OAUTH_MICROSOFT_TENANT_NOT_PINNED = 'OAUTH_MICROSOFT_TENANT_NOT_PINNED';

// -- Step-up provider re-auth (controllers/step-up-reauth.ts STEP_UP_REAUTH_ERROR_MAP)

/** The requested provider / SSO org isn't a re-auth option for this account. → 400 */
export const STEP_UP_REAUTH_UNAVAILABLE = 'STEP_UP_REAUTH_UNAVAILABLE';
/** The re-auth `state` is unknown, expired, replayed or belongs to another user. → 403 */
export const STEP_UP_REAUTH_INVALID_STATE = 'STEP_UP_REAUTH_INVALID_STATE';
/** The provider signed in an identity other than the one linked to this account. → 403 */
export const STEP_UP_REAUTH_IDENTITY_MISMATCH = 'STEP_UP_REAUTH_IDENTITY_MISMATCH';
/** The provider couldn't prove the sign-in happened during this re-auth. → 401 */
export const STEP_UP_REAUTH_NOT_RECENT = 'STEP_UP_REAUTH_NOT_RECENT';
/** A token-endpoint `id_token` whose audience/subject doesn't match this flow. → 401 */
export const OAUTH_INVALID_ID_TOKEN = 'OAUTH_INVALID_ID_TOKEN';

/** A renewal or mint would widen (or swap) a scoped credential's capability —
 *  a narrow machine token trading itself for a broader one. Mapped to 403. */
export const TOKEN_SCOPE_ESCALATION = 'TOKEN_SCOPE_ESCALATION';

/** A credential was derived from a token carrying no `amr`/`aal`/`auth_time`
 *  claims, so its assurance can't be inherited. Fail closed → 401. */
export const SESSION_AUTH_MISSING = 'SESSION_AUTH_MISSING';

/** A machine session (a stored credential from generate-token) was presented on
 *  POST /auth/refresh, which only renews interactive sessions. → 401 */
export const MACHINE_SESSION_NOT_REFRESHABLE = 'MACHINE_SESSION_NOT_REFRESHABLE';

/** The active org requires MFA (#8) and its grace period has passed, but the
 *  session being minted is only `aal: 1`. Thrown by `mintTokens`, the single
 *  issuance chokepoint, and mapped to 401 `MFA_REQUIRED` by every controller
 *  that issues or re-issues a session — the client's answer is to enrol a factor
 *  or sign in again with one, never to retry the same credential. */
export const MFA_REQUIRED_FOR_ORG = 'MFA_REQUIRED_FOR_ORG';

/** `POST /organization/:id/mfa-policy` tried to turn "require MFA" ON for the
 *  SYSTEM org while the bootstrap-admin exception is still open — which would
 *  lock out the only account that can close it. → 409 */
export const MFA_BOOTSTRAP_STILL_OPEN = 'MFA_BOOTSTRAP_STILL_OPEN';
