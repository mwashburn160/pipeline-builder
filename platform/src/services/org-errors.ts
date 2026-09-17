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
