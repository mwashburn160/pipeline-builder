// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { resolveOrgName } from './org-hierarchy-client.js';

/** A rule row as the inherited-source stamp sees it. */
interface SourceStampable {
  orgId?: string;
  inherited?: true;
  sourceOrgId?: string;
}

/**
 * Stamp `inherited` / `sourceOrgId` / `sourceOrgName` on the rules a team gets
 * from its parent org (`propagateToChildren`), so EVERY rule read labels them
 * identically.
 *
 * The merged `/enforced` view and the paginated `/compliance/rules` list each
 * had their own half of this and disagreed: the list resolved no name at all,
 * which is why the UI fell back to printing a raw org UUID at the reader.
 *
 * A rule counts as inherited when the caller already marked it (the enforced
 * merge does) or when the row is simply owned by the parent (the list read,
 * which widens to the parent's propagated rules). The display-name lookup is one
 * best-effort call, made only when at least one inherited rule is present, and a
 * failure leaves `sourceOrgName` unset — a label enrichment must never fail the
 * read it decorates, and the UI has generic copy for that case.
 */
export async function withInheritedSource<T extends SourceStampable>(
  rules: T[],
  parentOrgId: string | undefined,
): Promise<Array<T & { sourceOrgName?: string }>> {
  if (!parentOrgId) return rules;
  const parent = parentOrgId.toLowerCase();
  const isInherited = (r: T): boolean => r.inherited === true || r.orgId?.toLowerCase() === parent;
  if (!rules.some(isInherited)) return rules;

  const sourceOrgName = await resolveOrgName(parentOrgId);
  return rules.map((r) => (isInherited(r)
    ? { ...r, inherited: true as const, sourceOrgId: parentOrgId, ...(sourceOrgName ? { sourceOrgName } : {}) }
    : r));
}
