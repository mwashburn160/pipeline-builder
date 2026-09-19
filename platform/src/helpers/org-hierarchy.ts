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
 *
 * LIVE vs. ALL: the downward walk ({@link expandOrgScope}) is the LIVE scope — a
 * soft-deleted team (`deletedAt` set, inside its retention window) is excluded,
 * so rollups, team lists, pooled seats and tier/entitlement propagation stop
 * seeing it the moment it is deleted. The upward walk ({@link resolveOrgLineage}
 * / {@link isAncestorOrg}) deliberately does NOT filter: authorization over a
 * deleted team (restore, export) resolves through its parent exactly as it did
 * while it was live, and the purge sweep addresses orgs by id, never via this
 * walk. Use {@link hasAnyChildOrg} when a structural check must also see
 * deleted children.
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

/** Fetch a single org's direct parent id (cast-aware), or undefined. Soft-deleted
 *  orgs resolve like live ones (the upward walk never filters). */
export async function getParentOrgId(orgId: string): Promise<string | undefined> {
  const org = await Organization.findById(toOrgId(orgId)).select('parentOrgId').lean();
  return toOrgIdString(org?.parentOrgId);
}

/** Fetch the direct LIVE (not soft-deleted) child org ids of every org in `frontier`. */
async function getChildOrgIds(frontier: string[]): Promise<string[]> {
  // `deletedAt: null` matches both an explicit null and an absent field.
  const children = await Organization.find({ parentOrgId: { $in: frontier }, deletedAt: null })
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

/** Expand `orgId` to `[self, ...live descendants]` (visibility / analytics
 *  rollups, pooled seats, propagation). Soft-deleted teams are excluded. */
export function expandOrgScope(orgId: string): Promise<string[]> {
  return expandOrgScopeWith(orgId, getChildOrgIds);
}

/**
 * True when ANY org — live or soft-deleted — names `orgId` as its parent. The
 * structural twin of {@link expandOrgScope} for checks that must not be fooled
 * by a team sitting in its retention window (e.g. reparenting a root: a deleted
 * team restored later would otherwise end up two levels deep).
 */
export async function hasAnyChildOrg(orgId: string): Promise<boolean> {
  return !!(await Organization.exists({ parentOrgId: String(orgId) }));
}

/** An org's display name, or undefined when it doesn't resolve. Soft-deleted
 *  orgs still resolve — a label is not an authorization decision. */
export async function getOrgName(orgId: string | undefined | null): Promise<string | undefined> {
  if (!orgId) return undefined;
  const org = await Organization.findById(toOrgId(String(orgId))).select('name').lean();
  return (org as { name?: string } | null)?.name ?? undefined;
}
