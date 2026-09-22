// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * IdP group → Role mapping + just-in-time provisioning error codes.
 *
 * Thrown by the services and mapped to HTTP status in each controller's
 * `errorMap`. Dependency-free on purpose (see `org-errors.ts`): controllers,
 * the SSO login path and the tests import the codes without loading a service
 * and its models/config.
 */

import { RL_ASSIGN_EXCEEDS_CEILING, RL_ROLE_NOT_FOUND } from './roles-errors.js';
import type { ErrorMap } from '../helpers/controller-helper.js';

/** The org has no IdP config, so there is nothing to map groups for. */
export const IGM_NOT_CONFIGURED = 'IGM_NOT_CONFIGURED';
/** The org's provider issues no group claims (Google) — see `providerSupportsGroups`. */
export const IGM_PROVIDER_UNSUPPORTED = 'IGM_PROVIDER_UNSUPPORTED';
/** A mapping for that group already exists in this org. */
export const IGM_GROUP_TAKEN = 'IGM_GROUP_TAKEN';
/** No such mapping in this org. */
export const IGM_NOT_FOUND = 'IGM_NOT_FOUND';
/** Cap on mapping rules per org. A directory can have thousands of groups, but a
 *  rule set that large is a sign of a misconfiguration, and the collection is
 *  tenant-writable — the login-path resolver must stay bounded. */
export const MAX_MAPPINGS_PER_ORG = 100;
/** The org already holds {@link MAX_MAPPINGS_PER_ORG} rules. */
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
 * The config would be left unable to sign anyone in.
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
 * "SSO required" cannot be switched on yet: the policy locks people out of
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

/** The mapping routes' status map — the same refusal means the same thing on every verb. */
export const IDP_MAPPING_ERROR_MAP: ErrorMap = {
  [IGM_NOT_CONFIGURED]: { status: 409, message: 'Configure an identity provider for this organization before mapping its groups' },
  [IGM_PROVIDER_UNSUPPORTED]: {
    status: 400,
    message: 'Group-to-Role mapping is not available for Google: Google\'s OIDC tokens carry no group claim. Use a generic OIDC or Cognito identity provider.',
  },
  [IGM_GROUP_TAKEN]: { status: 409, message: 'A mapping for this group already exists' },
  [IGM_NOT_FOUND]: { status: 404, message: 'Group mapping not found' },
  [IGM_LIMIT]: { status: 409, message: `An organization can hold at most ${MAX_MAPPINGS_PER_ORG} group mappings` },
  [IGM_FORBIDDEN_GRANT]: { status: 403, message: 'A group mapping cannot grant organization ownership, platform-administrator or ecosystem-management authority' },
  [RL_ROLE_NOT_FOUND]: { status: 404, message: 'One or more roles do not exist in this organization' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot map a role granting permissions you do not hold yourself' },
};

/**
 * Typed write errors → HTTP status, shared by both IdP surfaces.
 *
 * The completeness rules are enforced on the RESULTING document in the service
 * (Mongoose can't express "required when `protocol` has this value"), so they
 * surface as thrown codes rather than as Zod issues and need mapping here or
 * they'd read as a 500 for what is plainly a bad request.
 */
export const ORG_IDP_ERROR_MAP: ErrorMap = {
  [IDP_SAML_INCOMPLETE]: { status: 400, message: 'A SAML configuration needs the identity provider\'s entity ID, SSO URL and at least one signing certificate' },
  [IDP_OIDC_INCOMPLETE]: { status: 400, message: 'An OIDC configuration needs a provider, client ID and client secret' },
  [IDP_SECRET_REQUIRED]: { status: 400, message: 'Re-enter the client secret: the provider, discovery URL, region or user pool changed, and a stored secret is never sent to a different identity provider' },
  [IDP_RESERVED_ISSUER]: { status: 400, message: 'This identity provider cannot use Google\'s issuer. Choose the Google provider (which always uses Google\'s own discovery document) instead of a custom discovery URL or entity ID.' },
  [IGM_PROVIDER_UNSUPPORTED]: { status: 400, message: 'This identity provider issues no group claims, so a groups claim cannot be set for it' },
  [IDP_SSO_REQUIRED_UNTESTED]: { status: 409, message: 'Single sign-on can only be required once the connection is enabled and a test connection has succeeded against the current settings. Run Test connection, then try again.' },
  [IDP_SSO_REQUIRED_NO_DOMAIN]: { status: 409, message: 'Verify at least one email domain before requiring single sign-on — the policy applies to people in your verified domains.' },
};
