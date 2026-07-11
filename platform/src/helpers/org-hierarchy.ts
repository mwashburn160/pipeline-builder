// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org → team hierarchy resolvers for the platform service (org-team-hierarchy
 * proposal, phase 1).
 *
 * The cycle-safe, depth-capped traversal lives in api-core
 * ({@link resolveOrgLineageWith} / {@link isAncestorOrgWith} /
 * {@link expandOrgScopeWith}); this module only supplies the platform's own
 * Mongoose query callbacks. The platform `Organization._id` is a plain ObjectId,
 * so id lookups cast 24-hex strings to ObjectId via the shared {@link toOrgId}
 * (a route param / stored string vs. an ObjectId both match the same doc).
 *
 * For a flat org (no `parentOrgId`, no teams nested under it) `resolveOrgLineage`
 * returns `{ rootOrgId: self }` and `expandOrgScope` returns `[self]`; once teams
 * are created (org → team hierarchy) these traverse the parent ↔ team links.
 */

import {
  type OrgLineage,
  resolveOrgLineageWith,
  isAncestorOrgWith,
  expandOrgScopeWith,
  toOrgIdString,
} from '@pipeline-builder/api-core';
import { toOrgId } from './org-id.js';
import { Organization } from '../models/index.js';

export type { OrgLineage };

/** Fetch a single org's direct parent id (cast-aware), or undefined. */
async function getParentOrgId(orgId: string): Promise<string | undefined> {
  const org = await Organization.findById(toOrgId(orgId)).select('parentOrgId').lean();
  return toOrgIdString(org?.parentOrgId);
}

/** Fetch the direct child org ids of every org in `frontier`. */
async function getChildOrgIds(frontier: string[]): Promise<string[]> {
  const children = await Organization.find({ parentOrgId: { $in: frontier } })
    .select('_id')
    .lean();
  return children.map((c) => toOrgIdString(c._id)).filter((id): id is string => !!id);
}

/** Walk `parentOrgId` up: direct parent (if any) + root of the ancestry chain. */
export function resolveOrgLineage(orgId: string): Promise<OrgLineage> {
  return resolveOrgLineageWith(orgId, getParentOrgId);
}

/** True when `ancestorOrgId` is an ancestor of `candidateOrgId` (effective RBAC). */
export function isAncestorOrg(ancestorOrgId: string, candidateOrgId: string): Promise<boolean> {
  return isAncestorOrgWith(ancestorOrgId, candidateOrgId, getParentOrgId);
}

/** Expand `orgId` to `[self, ...descendants]` (visibility / analytics rollups). */
export function expandOrgScope(orgId: string): Promise<string[]> {
  return expandOrgScopeWith(orgId, getChildOrgIds);
}
