// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM 2.0 protocol constants — schema URNs, the media type, the paging
 * bounds and the per-request member cap.
 *
 * Deliberately a module with NO imports, for the same reason
 * `constants/impersonation.ts` is: the response helper, the scope gate, the
 * service and the routes all need these, and pulling them through the service
 * would drag the model + config graph into a middleware that has no business
 * touching either (and into every suite that mocks it).
 */

/**
 * `envInt` through the `lib/*` SUBPATH, never the api-core barrel. This module's
 * whole point is that it pulls in nothing (see the note above), and the barrel
 * would drag express + the service graph into a middleware and into every suite
 * that mocks it — a suite mocking `@pipeline-builder/api-core` partially would
 * also make `envInt` throw, because `stubModule` refuses a non-overridden
 * export. `utils/env.ts` has NO imports of its own, so the subpath stays a leaf.
 * It is the shared reader rather than a local `Number(...)` so the strictness
 * (decimals, garbage, bounds) is the same one every other knob gets, and so the
 * env-documented guard can see these names.
 */
import { envInt } from '@pipeline-builder/api-core/lib/utils/env.js';

/** The media type RFC 7644 §3.1 requires on every SCIM request and response. */
export const SCIM_CONTENT_TYPE = 'application/scim+json';

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** Page size when the client doesn't ask, and the ceiling when it asks for more.
 *  A SCIM client is expected to page; an unbounded `count` would let one request
 *  materialize an entire directory in memory. Tunable because the right ceiling
 *  is a function of directory size and pod memory, neither of which this repo
 *  knows. The URNs and media type above stay hard constants: they are the
 *  PROTOCOL, and a deployment that varies them is simply not speaking SCIM. */
export const SCIM_DEFAULT_COUNT = envInt('SCIM_DEFAULT_COUNT', 100, { min: 1 });
export const SCIM_MAX_COUNT = envInt('SCIM_MAX_COUNT', 200, { min: 1 });

/** Most members one Groups write may carry. Okta and Entra both page their
 *  member pushes well below this; a larger body is a client bug, and each member
 *  costs a Role reconciliation. */
export const SCIM_MAX_MEMBERS_PER_REQUEST = envInt('SCIM_MAX_MEMBERS_PER_REQUEST', 500, { min: 1 });

/**
 * Per-ORG rate limit on the whole SCIM surface. Sized for a full directory sync
 * (Okta pushes a few requests per second during an initial import) while keeping
 * one tenant's IdP from monopolizing the service — the SCIM bucket is separate
 * from the general per-org limiter, so neither can starve the other.
 *
 * Both are env-tunable: an initial import from a 50k-seat directory and a
 * steady-state delta sync are orders of magnitude apart, and the docs previously
 * had to tell operators that changing this was a CODE change, not configuration.
 */
export const SCIM_RATE_LIMIT_WINDOW_MS = envInt('SCIM_RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000 });
export const SCIM_RATE_LIMIT_MAX = envInt('SCIM_RATE_LIMIT_MAX', 600, { min: 1 });
