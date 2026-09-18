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
