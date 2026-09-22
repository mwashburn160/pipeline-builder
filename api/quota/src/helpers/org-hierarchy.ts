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
 * A flat org (no parent, no teams) resolves in the single
 * {@link findOrgWithHierarchy} query and never walks the tree.
 */

import {
  createMongoOrgHierarchy,
  resolveRootOrgIdWith,
  expandOrgScopeWith,
  toOrgIdString,
} from '@pipeline-builder/api-core';
import { toOrgId } from './org-id.js';
import { Organization } from '../models/organization.js';

const { getParentOrgId, getChildOrgIds } = createMongoOrgHierarchy(Organization, toOrgId);

/** A single org's direct parent id (cast-aware), or undefined for a root / missing org. */
export { getParentOrgId };

/** One org's own row plus its position in the org → team hierarchy. */
export interface OrgHierarchyLookup<T> {
  /** The org's own row (with the requested fields), or null when it does not exist. */
  self: T | null;
  /** Direct parent id, or undefined for a root / flat org. */
  parentOrgId?: string;
  /** True when at least one org names this org as its parent. */
  hasChildren: boolean;
}

/**
 * Read an org's own row AND learn whether it sits in a hierarchy in ONE query:
 * `{ _id: self } ∪ { live teams of self }`. A flat org (no parent, no teams) —
 * the common case — therefore costs exactly this single round trip; only an org
 * with a parent or with teams goes on to walk the tree. `fields` is the extra
 * projection for the self row (`parentOrgId` is always selected).
 */
export async function findOrgWithHierarchy<T extends object>(
  orgId: string,
  fields: string,
): Promise<OrgHierarchyLookup<T>> {
  const rows = await Organization.find({ $or: [{ _id: toOrgId(orgId) }, { parentOrgId: orgId, deletedAt: null }] })
    .select(`${fields} parentOrgId`.trim())
    .lean() as unknown as Array<T & { _id?: unknown; parentOrgId?: unknown }>;
  let self: (T & { parentOrgId?: unknown }) | null = null;
  let hasChildren = false;
  for (const row of rows) {
    if (toOrgIdString(row._id) === orgId) self = row;
    else hasChildren = true;
  }
  return { self, parentOrgId: toOrgIdString(self?.parentOrgId), hasChildren };
}

/** Walk `parentOrgId` up to the root. Returns the input itself for a root org. */
export function resolveRootOrgId(orgId: string): Promise<string> {
  return resolveRootOrgIdWith(orgId, getParentOrgId);
}

/** Expand `orgId` to itself plus every descendant org id (BFS over `parentOrgId`). */
export function expandOrgScope(orgId: string): Promise<string[]> {
  return expandOrgScopeWith(orgId, getChildOrgIds);
}
