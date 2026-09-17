// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * User account error codes (self-serve profile and admin user management).
 *
 * Thrown by the services and mapped to HTTP status in each controller's
 * `errorMap`. Dependency-free on purpose (see `org-errors.ts`): controllers and
 * tests import the codes without loading a service and its models/config.
 */

/** The account owns an organization, so it can't be deleted (transfer ownership
 *  first). Thrown by the shared user-delete cascade for both self-serve and
 *  admin deletion. Its last-privileged-member twin is `RL_LAST_PRIVILEGED_MEMBER`. */
export const USER_OWNER_HAS_ORGS = 'USER_OWNER_HAS_ORGS';

export const UA_USER_NOT_FOUND = 'UA_USER_NOT_FOUND';
export const UA_USERNAME_TAKEN = 'UA_USERNAME_TAKEN';
export const UA_EMAIL_TAKEN = 'UA_EMAIL_TAKEN';
export const UA_ORG_NOT_FOUND = 'UA_ORG_NOT_FOUND';
/** Refused an attempt to change the role of an org OWNER's membership. The owner
 *  role can only move via `transferOwnership` (which atomically re-homes it);
 *  a plain role edit would demote/orphan the org. */
export const UA_CANNOT_CHANGE_OWNER = 'UA_CANNOT_CHANGE_OWNER';
/** Target org is at its seat cap (`org.quotas.seats`) — assigning this user
 *  would exceed it. Same limit the invite/add paths enforce. */
export const UA_SEAT_LIMIT = 'UA_SEAT_LIMIT';
/** Role assignment was requested without an organization. Roles are
 *  org-scoped, so `createUser` can't attach them to an org-less user. */
export const UA_ROLES_NEED_ORG = 'UA_ROLES_NEED_ORG';

export const PROFILE_USER_NOT_FOUND = 'PROFILE_USER_NOT_FOUND';
export const PROFILE_EMAIL_TAKEN = 'PROFILE_EMAIL_TAKEN';
export const PROFILE_INVALID_CREDENTIALS = 'PROFILE_INVALID_CREDENTIALS';
export const PROFILE_PAT_LIMIT = 'PROFILE_PAT_LIMIT';
