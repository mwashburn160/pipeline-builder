// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org + ancestor read shared by the per-org SECURITY policies that inherit
 * "strictest wins" (the password policy and the authenticator allowlist).
 *
 * One read per hop, nearest first, starting with the org itself; a cycle or a
 * missing document simply ends the walk. The same depth cap api-core's lineage
 * resolver uses, so a mis-parented cycle can't spin here either. Models are
 * loaded on demand for the same reason `mfa-policy.ts` does it: validation
 * schemas and controllers import the policy modules for constants, and must not
 * drag the whole model graph in to read a number.
 */

import type { OrganizationData } from '../models/index.js';

/** Depth cap for the ancestor walk. */
const MAX_ANCESTOR_DEPTH = 32;

async function deps() {
  const [models, orgId] = await Promise.all([
    import('../models/index.js'),
    import('./org-id.js'),
  ]);
  return { Organization: models.Organization, toOrgId: orgId.toOrgId };
}

/** One org in the walk: its id plus the requested policy fields. */
export type LineageDoc<T> = T & { _id: string };

/**
 * `orgId` and each of its ancestors, nearest first, with `fields` selected.
 * Returns `[]` when the org itself does not exist.
 */
export async function readOrgPolicyLineage<T extends object>(
  orgId: string,
  fields: string,
): Promise<Array<LineageDoc<T>>> {
  const { Organization, toOrgId } = await deps();
  const out: Array<LineageDoc<T>> = [];
  const seen = new Set<string>();
  let current: string | undefined = orgId;
  for (let depth = 0; current && depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const doc: (Partial<OrganizationData> & { _id: unknown }) | null = await Organization.findById(toOrgId(current))
      .select(`${fields} parentOrgId`).lean();
    if (!doc) break;
    const { parentOrgId, ...rest }: { parentOrgId?: string | null } & Record<string, unknown> = doc;
    out.push({ ...(rest as unknown as T), _id: String(doc._id) });
    current = parentOrgId ? String(parentOrgId) : undefined;
  }
  return out;
}
