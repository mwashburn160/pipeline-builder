// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org → team hierarchy traversal (org-team-hierarchy proposal).
 *
 * A "team" is an organization whose `parentOrgId` points at another org; a root
 * org has `parentOrgId = null`. These helpers walk that single self-referential
 * column, but hold **no database dependency** of their own: each takes a query
 * callback so every service (platform, quota, …) can share the cycle-safe,
 * depth-capped traversal logic while reading its own Mongoose model with its own
 * `_id` casting rules.
 *
 *   - {@link resolveOrgLineageWith} — UP: direct parent + root of the chain.
 *   - {@link resolveRootOrgIdWith}   — UP: just the root id.
 *   - {@link isAncestorOrgWith}      — UP: is A an ancestor of B?
 *   - {@link expandOrgScopeWith}     — DOWN: self + all descendant org ids.
 *
 * Every org is flat today (`parentOrgId` null on all rows), so lineage resolves
 * to `{ rootOrgId: self }` and scope to `[self]` — i.e. these are no-ops until
 * orgs get parents.
 */

/** Hard ceiling on ancestry/descendant traversal — cycle + abuse guard. */
export const MAX_ORG_DEPTH = 16;

/** Fetch an org's direct `parentOrgId`, or undefined for a root/missing org. */
export type GetParentOrgId = (orgId: string) => Promise<string | undefined>;

/** Fetch the direct child org ids of every org in `frontier` (one round of BFS). */
export type GetChildOrgIds = (frontier: string[]) => Promise<string[]>;

/** Normalize a Mixed/ObjectId/string org id to a non-empty string, or undefined. */
export function toOrgIdString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s && s !== 'null' && s !== 'undefined' ? s : undefined;
}

export interface OrgLineage {
  /** The org's direct parent id, or `undefined` when it's a root org. */
  parentOrgId?: string;
  /** Top of the ancestry chain. Equals the input `orgId` for a root org. */
  rootOrgId: string;
}

/**
 * Walk `parentOrgId` from `orgId` up to the root. Returns the direct parent (if
 * any) and the root org id (the input itself when the org has no parent). On a
 * detected cycle, a missing org, or the depth cap, traversal stops and the last
 * reached id is treated as the root.
 */
export async function resolveOrgLineageWith(orgId: string, getParent: GetParentOrgId): Promise<OrgLineage> {
  const seen = new Set<string>([orgId]);
  let currentId = orgId;
  let parentOrgId: string | undefined;

  for (let depth = 0; depth < MAX_ORG_DEPTH; depth++) {
    const parent = toOrgIdString(await getParent(currentId));
    if (!parent) break; // currentId is the root
    // Record the direct parent only when it isn't a self-loop, so a malformed
    // A→A org isn't reported as its own parent.
    if (depth === 0 && parent !== orgId) parentOrgId = parent;
    if (seen.has(parent)) break; // cycle — treat currentId as the root
    seen.add(parent);
    currentId = parent;
  }

  return { rootOrgId: currentId, ...(parentOrgId && { parentOrgId }) };
}

/** Walk `parentOrgId` up to the root and return just the root id. */
export async function resolveRootOrgIdWith(orgId: string, getParent: GetParentOrgId): Promise<string> {
  return (await resolveOrgLineageWith(orgId, getParent)).rootOrgId;
}

/**
 * True when `ancestorOrgId` is an ancestor of `candidateOrgId` — i.e.
 * `candidateOrgId` lives somewhere in the subtree rooted at `ancestorOrgId`.
 * Walks `candidateOrgId`'s parent chain upward, depth-capped and cycle-safe.
 * Returns `false` when the two are equal (an org is not its own ancestor) or
 * unrelated.
 */
export async function isAncestorOrgWith(
  ancestorOrgId: string,
  candidateOrgId: string,
  getParent: GetParentOrgId,
): Promise<boolean> {
  if (ancestorOrgId === candidateOrgId) return false;

  const seen = new Set<string>([candidateOrgId]);
  let currentId = candidateOrgId;

  for (let depth = 0; depth < MAX_ORG_DEPTH; depth++) {
    const parent = toOrgIdString(await getParent(currentId));
    if (!parent) return false; // reached a root without matching
    if (parent === ancestorOrgId) return true;
    if (seen.has(parent)) return false; // cycle
    seen.add(parent);
    currentId = parent;
  }

  return false;
}

/**
 * Expand `orgId` to itself plus every descendant org id (breadth-first over
 * `parentOrgId`). This is the scope a parent org "sees" for visibility and
 * analytics rollups: `[self, ...descendants]`. Returns `[orgId]` when the org
 * has no children. Cycle-safe and depth-capped.
 */
export async function expandOrgScopeWith(orgId: string, getChildren: GetChildOrgIds): Promise<string[]> {
  const result: string[] = [orgId];
  const seen = new Set<string>([orgId]);
  let frontier: string[] = [orgId];

  for (let depth = 0; depth < MAX_ORG_DEPTH && frontier.length > 0; depth++) {
    const children = await getChildren(frontier);
    const next: string[] = [];
    for (const raw of children) {
      const id = toOrgIdString(raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
      next.push(id);
    }
    frontier = next;
  }

  return result;
}
