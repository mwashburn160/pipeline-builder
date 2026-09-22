// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Service-account error codes (dependency-free, like every other `*-errors.ts`
 * module) so controllers can map them to HTTP status without importing the
 * service — and therefore its model graph.
 */

/** No such service account in the target org. */
export const SA_NOT_FOUND = 'SA_NOT_FOUND';
/** Another account in this org already uses that name. */
export const SA_NAME_TAKEN = 'SA_NAME_TAKEN';
/** The name is not a machine identifier (`[a-z0-9][a-z0-9_-]{1,63}`). */
export const SA_INVALID_NAME = 'SA_INVALID_NAME';
/** The org is at its service-account ceiling. */
export const SA_LIMIT = 'SA_LIMIT';
/** The account already holds the maximum number of ACTIVE keys. */
export const SA_KEY_LIMIT = 'SA_KEY_LIMIT';
/** Requested key lifetime exceeds the 365-day maximum (or is not positive). */
export const SA_KEY_EXPIRY_INVALID = 'SA_KEY_EXPIRY_INVALID';
/** An IP-allowlist entry is not a valid IPv4/IPv6 address or CIDR block. */
export const SA_INVALID_IP_ALLOWLIST = 'SA_INVALID_IP_ALLOWLIST';
/** `tokenBudget` must be a positive integer, or -1 for unlimited. */
export const SA_INVALID_BUDGET = 'SA_INVALID_BUDGET';
/** The owning org does not exist (or is soft-deleted). */
export const SA_ORG_NOT_FOUND = 'SA_ORG_NOT_FOUND';
/** The named key does not belong to this service account. */
export const SA_KEY_NOT_FOUND = 'SA_KEY_NOT_FOUND';
/** The requested key scope is not in api-core's `TOKEN_SCOPES` catalog. */
export const SA_INVALID_SCOPE = 'SA_INVALID_SCOPE';

/** The actor may not mint a key with this capability scope: `scim` needs org
 *  admin (or `members:manage` + `roles:manage`) and the org's SSO entitlement;
 *  `registry:push` needs `plugins:write`. */
export const SA_SCOPE_NOT_PERMITTED = 'SA_SCOPE_NOT_PERMITTED';
