// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization membership error codes.
 *
 * Thrown by the services and mapped to HTTP status in each controller's
 * `errorMap`. Dependency-free on purpose (see `org-errors.ts`): controllers and
 * tests import the codes without loading a service and its models/config.
 */

export const OM_ORG_NOT_FOUND = 'OM_ORG_NOT_FOUND';
export const OM_USER_NOT_FOUND = 'OM_USER_NOT_FOUND';
export const OM_ALREADY_MEMBER = 'OM_ALREADY_MEMBER';
export const OM_NOT_A_MEMBER = 'OM_NOT_A_MEMBER';
export const OM_CANNOT_REMOVE_OWNER = 'OM_CANNOT_REMOVE_OWNER';
export const OM_OWNER_MEMBERSHIP_NOT_FOUND = 'OM_OWNER_MEMBERSHIP_NOT_FOUND';
export const OM_NEW_OWNER_MUST_BE_MEMBER = 'OM_NEW_OWNER_MUST_BE_MEMBER';
export const OM_MEMBERSHIP_NOT_FOUND = 'OM_MEMBERSHIP_NOT_FOUND';
export const OM_ALREADY_INACTIVE = 'OM_ALREADY_INACTIVE';
export const OM_ALREADY_ACTIVE = 'OM_ALREADY_ACTIVE';
/** A bulk-add target org is outside the context org's subtree (a parent admin
 *  may only place members on teams they administer, i.e. descendants). */
export const OM_TARGETS_OUT_OF_SCOPE = 'OM_TARGETS_OUT_OF_SCOPE';
/** The org is at its seat cap (`org.quotas.seats`); adding this member would
 *  exceed it. Mirrors the seat check enforced at invite time. */
export const OM_SEAT_LIMIT = 'OM_SEAT_LIMIT';
