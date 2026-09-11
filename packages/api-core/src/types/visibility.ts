// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The single sharing model for every catalog entity: pipelines, plugins,
 * pipeline templates, and dashboards.
 *
 * Three rungs, widening left to right:
 *
 * - `private` — only the AUTHOR (`createdBy`) can see or edit it. A personal
 *   draft: somewhere to iterate before anyone else is affected.
 * - `org`     — everyone in the owning org can see it; the resource's `:write`
 *   permission edits it. This is the default working state for shared content.
 * - `public`  — shared beyond the org: a team also sees its parent org's public
 *   rows, and the system org's public rows are the shared catalog every org
 *   sees. Requires the resource's `:publish` permission.
 *
 * Enforcement lives in exactly two places, so no entity can drift:
 * `AccessControlQueryBuilder` builds the read predicate, and
 * `requireVisibilityWriteAccess` gates the writes.
 */
export const VISIBILITIES = ['private', 'org', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
