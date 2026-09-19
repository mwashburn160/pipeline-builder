// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization error sentinels — thrown by the org services, mapped to HTTP
 * status in each controller's `errorMap` (see `helpers/controller-helper.ts`).
 *
 * One module rather than per-service declarations: `organization-service` and
 * `org-cascade-service` each declared their own `ORG_NOT_FOUND` /
 * `SYSTEM_ORG_DELETE_FORBIDDEN`, and the cascade copy carried a comment saying
 * "same string value as organization-service's export — the controller errorMap
 * uses that one". That is the failure mode written down: the two are matched by
 * string VALUE, so a typo in either silently stops the controller's map from
 * matching and the caller gets a generic 500 instead of a 404/400.
 */

/** The org does not exist. → 404 */
export const ORG_NOT_FOUND = 'ORG_NOT_FOUND';

/** The system org can never be deleted. → 400 */
export const SYSTEM_ORG_DELETE_FORBIDDEN = 'SYSTEM_ORG_DELETE_FORBIDDEN';

/** An explicit slug collides with another org. → 409 */
export const ORG_SLUG_TAKEN = 'ORG_SLUG_TAKEN';

/**
 * The org is already soft-deleted (inside its retention window). → 409
 *
 * A repeat delete is a no-op the caller should SEE, rather than a silent
 * overwrite of the original `deletedAt` / snapshot.
 */
export const ORG_ALREADY_DELETED = 'ORG_ALREADY_DELETED';

/** The pre-delete snapshot could not be written, so the delete was refused. → 500 */
export const ORG_SNAPSHOT_FAILED = 'ORG_SNAPSHOT_FAILED';

/** An AI provider key value exceeded the accepted length (see organization-ai-secrets). → 400 */
export const ORG_AI_KEY_TOO_LONG = 'ORG_AI_KEY_TOO_LONG';

/** A team id that is not a (direct) team of the org named in the route. → 404 */
export const ORG_TEAM_NOT_FOUND = 'ORG_TEAM_NOT_FOUND';

/** Restoring/moving would put the account over its pooled seat cap. → 409 */
export const ORG_SEAT_LIMIT = 'ORG_SEAT_LIMIT';

/** A team can't be restored: its parent is gone or soft-deleted. → 409 */
export const ORG_RESTORE_PARENT_GONE = 'ORG_RESTORE_PARENT_GONE';

/** A team can't be restored: its parent can no longer hold teams (it became a
 *  team itself, or its tier no longer includes teams). → 409 */
export const ORG_RESTORE_PARENT_INELIGIBLE = 'ORG_RESTORE_PARENT_INELIGIBLE';

// Reparenting (POST /organization/:id/move). All → 400 except where noted.

/** The org (or the destination) is the system org. */
export const ORG_MOVE_SYSTEM = 'ORG_MOVE_SYSTEM';
/** The org is soft-deleted. → 409 */
export const ORG_MOVE_DELETED = 'ORG_MOVE_DELETED';
/** `parentOrgId` names the org itself. */
export const ORG_MOVE_SELF = 'ORG_MOVE_SELF';
/** The destination is a descendant of the org being moved. */
export const ORG_MOVE_CYCLE = 'ORG_MOVE_CYCLE';
/** The org has teams (live or soft-deleted) — it can't become a team itself. */
export const ORG_MOVE_HAS_TEAMS = 'ORG_MOVE_HAS_TEAMS';
/** The destination does not exist (or is soft-deleted). → 404 */
export const ORG_MOVE_TARGET_NOT_FOUND = 'ORG_MOVE_TARGET_NOT_FOUND';
/** The destination is itself a team (nesting is one level deep). */
export const ORG_MOVE_TARGET_NOT_ROOT = 'ORG_MOVE_TARGET_NOT_ROOT';
/** The destination's tier does not include teams. */
export const ORG_MOVE_TARGET_TIER = 'ORG_MOVE_TARGET_TIER';
/** The org is already where it was asked to go. */
export const ORG_MOVE_NOOP = 'ORG_MOVE_NOOP';
/** A root with a billable subscription can't become a team (its plan would pool
 *  under another account while its own subscription kept charging). → 409 */
export const ORG_MOVE_BILLED = 'ORG_MOVE_BILLED';
/** Billing couldn't confirm the org has no billable subscription (fail closed). → 503 */
export const ORG_MOVE_BILLING_UNVERIFIED = 'ORG_MOVE_BILLING_UNVERIFIED';
