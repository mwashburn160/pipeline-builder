// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org → team hierarchy resolvers for the quota service. The cycle-safe,
 * depth-capped traversal lives in api-core ({@link resolveRootOrgIdWith} /
 * {@link expandOrgScopeWith}); this module only supplies the quota service's own
 * Mongoose query callbacks against the shared `organizations` collection. Used
 * to roll a team's usage up to its root for the shared-cap check.
 *
 * Org `_id`s in that collection are ObjectId (platform-written) except string
 * ids like the well-known `'system'` org, so lookups cast via {@link toOrgId}.
 *
 * Every org is flat today (`parentOrgId` null), so `resolveRootOrgId` returns
 * the input and `expandOrgScope` returns `[self]` — no-ops until orgs get parents.
 */

import {
  resolveRootOrgIdWith,
  expandOrgScopeWith,
  toOrgIdString,
} from '@pipeline-builder/api-core';
import { toOrgId } from './org-id';
import { Organization } from '../models/organization';

/** Fetch a single org's direct parent id (cast-aware), or undefined. */
async function getParentOrgId(orgId: string): Promise<string | undefined> {
  const org = await Organization.findById(toOrgId(orgId)).select('parentOrgId').lean();
  return toOrgIdString((org as { parentOrgId?: unknown } | null)?.parentOrgId);
}

/** Fetch the direct child org ids of every org in `frontier`. */
async function getChildOrgIds(frontier: string[]): Promise<string[]> {
  const children = await Organization.find({ parentOrgId: { $in: frontier } })
    .select('_id')
    .lean();
  return children
    .map((c) => toOrgIdString((c as { _id?: unknown })._id))
    .filter((id): id is string => !!id);
}

/** Walk `parentOrgId` up to the root. Returns the input itself for a root org. */
export function resolveRootOrgId(orgId: string): Promise<string> {
  return resolveRootOrgIdWith(orgId, getParentOrgId);
}

/** Expand `orgId` to itself plus every descendant org id (BFS over `parentOrgId`). */
export function expandOrgScope(orgId: string): Promise<string[]> {
  return expandOrgScopeWith(orgId, getChildOrgIds);
}
