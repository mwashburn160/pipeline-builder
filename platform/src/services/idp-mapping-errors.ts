// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * IdP group → Role mapping + just-in-time provisioning error codes (3a).
 *
 * Thrown by the services and mapped to HTTP status in each controller's
 * `errorMap`. Dependency-free on purpose (see `org-errors.ts`): controllers,
 * the SSO login path and the tests import the codes without loading a service
 * and its models/config.
 */

/** The org has no IdP config, so there is nothing to map groups for. */
export const IGM_NOT_CONFIGURED = 'IGM_NOT_CONFIGURED';
/** The org's provider issues no group claims (Google) — see `providerSupportsGroups`. */
export const IGM_PROVIDER_UNSUPPORTED = 'IGM_PROVIDER_UNSUPPORTED';
/** A mapping for that group already exists in this org. */
export const IGM_GROUP_TAKEN = 'IGM_GROUP_TAKEN';
/** No such mapping in this org. */
export const IGM_NOT_FOUND = 'IGM_NOT_FOUND';
/** The org already holds `MAX_MAPPINGS_PER_ORG` rules. */
export const IGM_LIMIT = 'IGM_LIMIT';
/**
 * The Role set would grant owner or platform-administrator authority. A mapping
 * is an AUTOMATED grant driven by a directory the platform doesn't control, so
 * the two authorities that can't be taken back by an in-org admin — org
 * ownership and `superadmin` — are off-limits to it no matter who is editing.
 */
export const IGM_FORBIDDEN_GRANT = 'IGM_FORBIDDEN_GRANT';

/**
 * JIT membership refused because the account is at its pooled seat limit. The
 * SSO sign-in fails with this (mapped in `OIDC_ERROR_MAP`) rather than issuing a
 * session with no membership — the same answer the invitation path gives.
 */
export const JIT_SEAT_LIMIT = 'JIT_SEAT_LIMIT';

/**
 * The config would be left unable to sign anyone in (#4).
 *
 * `protocol` decides which fields matter, and Mongoose can't express "required
 * when another field has a given value" — so the write path refuses a SAML
 * config missing its entity id / SSO URL / certificate, or an OIDC config
 * missing its provider / client id / client secret, rather than storing a
 * connection whose failure only shows up at somebody's next sign-in.
 */
export const IDP_SAML_INCOMPLETE = 'IDP_SAML_INCOMPLETE';
export const IDP_OIDC_INCOMPLETE = 'IDP_OIDC_INCOMPLETE';

/**
 * The config would let an admin-run IdP present a RESERVED issuer (Google,
 * whose identities skip domain verification): a custom discoveryUrl on the
 * `google` provider, a generic OIDC discovery URL on Google's host, or a SAML
 * entity id equal to Google's issuer. See helpers/reserved-issuers.ts.
 */
export const IDP_RESERVED_ISSUER = 'IDP_RESERVED_ISSUER';

/**
 * The edit points the connection at a DIFFERENT identity provider — provider,
 * discoveryUrl, region or userPoolId changed — without re-entering the client
 * secret. The stored secret is only ever carried forward to the IdP it was
 * entered for: re-using it would hand it to whatever token endpoint the new
 * settings resolve to (an admin, or an attacker holding an admin session, could
 * exfiltrate it by pointing discovery at their own host).
 */
export const IDP_SECRET_REQUIRED = 'IDP_SECRET_REQUIRED';

/**
 * "SSO required" cannot be switched on yet (#5): the policy locks people out of
 * every other sign-in method, so it is only accepted once the IdP is ENABLED and
 * a test connection has SUCCEEDED against the settings currently saved (a
 * connection change clears the last result).
 */
export const IDP_SSO_REQUIRED_UNTESTED = 'IDP_SSO_REQUIRED_UNTESTED';

/** "SSO required" with no DNS-verified domain would govern nobody — refused so
 *  the setting never claims an enforcement that isn't happening. */
export const IDP_SSO_REQUIRED_NO_DOMAIN = 'IDP_SSO_REQUIRED_NO_DOMAIN';

/** An allowed email domain the org has not DNS-verified. The picker offers only
 *  verified domains; this is the server-side half of that rule. */
export const IDP_DOMAIN_NOT_VERIFIED = 'IDP_DOMAIN_NOT_VERIFIED';
