// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM 2.0 protocol constants (3b) — schema URNs, the media type, the paging
 * bounds and the per-request member cap.
 *
 * Deliberately a module with NO imports, for the same reason
 * `constants/impersonation.ts` is: the response helper, the scope gate, the
 * service and the routes all need these, and pulling them through the service
 * would drag the model + config graph into a middleware that has no business
 * touching either (and into every suite that mocks it).
 */

/** The media type RFC 7644 §3.1 requires on every SCIM request and response. */
export const SCIM_CONTENT_TYPE = 'application/scim+json';

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** Page size when the client doesn't ask, and the ceiling when it asks for more.
 *  A SCIM client is expected to page; an unbounded `count` would let one request
 *  materialize an entire directory in memory. */
export const SCIM_DEFAULT_COUNT = 100;
export const SCIM_MAX_COUNT = 200;

/** Most members one Groups write may carry. Okta and Entra both page their
 *  member pushes well below this; a larger body is a client bug, and each member
 *  costs a Role reconciliation. */
export const SCIM_MAX_MEMBERS_PER_REQUEST = 500;

/**
 * Per-ORG rate limit on the whole SCIM surface. Sized for a full directory sync
 * (Okta pushes a few requests per second during an initial import) while keeping
 * one tenant's IdP from monopolizing the service — the SCIM bucket is separate
 * from the general per-org limiter, so neither can starve the other.
 */
export const SCIM_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const SCIM_RATE_LIMIT_MAX = 600;
