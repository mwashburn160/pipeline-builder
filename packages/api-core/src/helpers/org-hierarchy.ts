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
 * A root org (`parentOrgId` null) resolves to `{ rootOrgId: self }` and scope
 * `[self]`.
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

/** True when `id` is a 24-character hex string — i.e. castable to an ObjectId. */
function isObjectIdHex(id: string): boolean {
  return id.length === 24 && /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Build the org-id cast the Mongo-backed services use on every `_id` lookup.
 *
 * Platform writes ObjectId `_id`s into the shared `organizations` collection,
 * while the well-known `'system'` org (and `parentOrgId`, still a String column)
 * are plain strings — so a 24-hex id arriving from a route param / JWT claim /
 * cross-service payload must be cast or `findById('<24hex>')` never matches.
 *
 * Platform and quota each had their OWN `toOrgId` with a different signature
 * (`string | string[]` vs `string`), which is exactly the drift this removes:
 * the logic and the signature live here once, and each service supplies only
 * its mongoose `Types.ObjectId` constructor. api-core cannot import mongoose
 * itself (it is not — and should not become — an api-core dependency), so the
 * constructor is injected rather than imported.
 *
 * @example
 * export const toOrgId = createOrgIdCaster(mongoose.Types.ObjectId);
 */
export function createOrgIdCaster<T>(
  ObjectIdCtor: new (hex: string) => T,
): (id: string | string[]) => string | T {
  return (id) => {
    const idStr = Array.isArray(id) ? id[0] : id;
    return isObjectIdHex(idStr) ? new ObjectIdCtor(idStr) : idStr;
  };
}

/**
 * The slice of a Mongoose `Organization` model the hierarchy callbacks read.
 * Structural (api-core has no mongoose dependency); `select().lean()` chains as
 * mongoose queries do.
 */
export interface OrgHierarchyModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findById(id: any): { select(fields: string): { lean(): PromiseLike<unknown> } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  find(filter: any): { select(fields: string): { lean(): PromiseLike<unknown[]> } };
}

/**
 * The parent/children lookups over a service's own `organizations` model, for
 * the `*With` traversals below. `getChildOrgIds` returns LIVE children only (a
 * soft-deleted team leaves every downward scope); `getParentOrgId` does not
 * filter, so a deleted team still resolves through its parent.
 */
export function createMongoOrgHierarchy(
  Model: OrgHierarchyModel,
  toOrgId: (id: string) => unknown,
): { getParentOrgId: GetParentOrgId; getChildOrgIds: GetChildOrgIds } {
  return {
    async getParentOrgId(orgId) {
      const org = await Model.findById(toOrgId(orgId)).select('parentOrgId').lean();
      return toOrgIdString((org as { parentOrgId?: unknown } | null)?.parentOrgId);
    },
    async getChildOrgIds(frontier) {
      // `deletedAt: null` matches both an explicit null and an absent field.
      const children = await Model.find({ parentOrgId: { $in: frontier }, deletedAt: null }).select('_id').lean();
      return children
        .map((c) => toOrgIdString((c as { _id?: unknown })._id))
        .filter((id): id is string => !!id);
    },
  };
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
 * Fail-CLOSED variant of {@link resolveRootOrgIdWith}: returns `null` when the
 * root can't be proven — a cycle or a chain deeper than {@link MAX_ORG_DEPTH} —
 * instead of treating the last reached id as the root. Lookup errors propagate.
 * For callers where a wrong root is worse than no answer (e.g. a retention purge
 * that would otherwise apply a team's shorter default window).
 */
export async function resolveRootOrgIdStrict(orgId: string, getParent: GetParentOrgId): Promise<string | null> {
  const seen = new Set<string>([orgId]);
  let currentId = orgId;
  for (let depth = 0; depth < MAX_ORG_DEPTH; depth++) {
    const parent = toOrgIdString(await getParent(currentId));
    if (!parent || parent === currentId) return currentId;
    if (seen.has(parent)) return null;
    seen.add(parent);
    currentId = parent;
  }
  return null;
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
