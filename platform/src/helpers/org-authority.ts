// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What authority a user holds INSIDE one org — the single rule every place that
 * scopes a session to an org applies (switch-org, token issuance, the refresh
 * path), so the three can never disagree about who may be "in" a team.
 *
 * Two sources:
 *   - a live, active `UserOrganization` row in the org itself (`membership`);
 *   - an active `admin`/`owner` membership in a live ANCESTOR of the org
 *     (`ancestor`) — the same rule `canAdministerOrg` applies to a request made
 *     from the parent: an admin of a parent administers its teams.
 *
 * Inherited authority resolves to role `admin` — never `owner`: ownership is a
 * designation of one specific org (transfer-owner, the owner-preservation rules)
 * and is not conferred downward. Its permissions are the ancestor Roles' bundle
 * (the authority actually held), unioned with any Roles the user also holds in
 * the team. NOTHING is written: no membership row appears on the team's roster,
 * no seat is consumed, and the authority disappears as soon as the ancestor
 * membership stops qualifying (removal / demotion bump tokenVersion, and the next
 * issuance re-resolves here).
 *
 * A direct `admin`/`owner` membership wins outright. A direct plain-`member`
 * row loses to an inherited admin — otherwise a parent admin who happens to sit
 * on a team as a member would have LESS authority inside the team than they have
 * over it from the parent.
 */

import { getParentOrgId } from './org-hierarchy.js';
import { toOrgId } from './org-id.js';
import { Organization, UserOrganization } from '../models/index.js';
import type { OrgMemberRole } from '../models/user-organization.js';

export interface OrgAuthority {
  role: OrgMemberRole;
  via: 'membership' | 'ancestor';
  /** For `via: 'ancestor'` — the ancestor org whose membership confers it. */
  inheritedFromOrgId?: string;
  /** Orgs whose Role assignments make up the session's permissions. */
  permissionOrgIds: string[];
}

/** Hard cap on the upward walk — nesting is one level deep today; the cap only
 *  bounds a corrupted (cyclic) chain. */
const MAX_ANCESTOR_DEPTH = 8;

/**
 * The nearest LIVE ancestor of `orgId` in which `userId` holds an active
 * `admin`/`owner` membership, or undefined. `orgId` itself is not considered
 * (that is a direct membership, not inherited authority).
 */
export async function findAncestorAdminMembership(
  userId: string,
  orgId: string,
): Promise<{ ancestorOrgId: string; role: 'admin' | 'owner' } | undefined> {
  const seen = new Set<string>([String(orgId)]);
  let current = await getParentOrgId(orgId);
  for (let depth = 0; current && !seen.has(current) && depth < MAX_ANCESTOR_DEPTH; depth++) {
    seen.add(current);
    const membership = await UserOrganization.findOne({
      userId,
      organizationId: toOrgId(current),
      isActive: true,
      role: { $in: ['admin', 'owner'] },
    }).lean();
    if (membership) {
      const ancestor = await Organization.findById(toOrgId(current)).select('deletedAt').lean();
      // A soft-deleted ancestor confers nothing — its own sessions are already cut.
      if (ancestor && !(ancestor as { deletedAt?: Date | null }).deletedAt) {
        return { ancestorOrgId: current, role: membership.role as 'admin' | 'owner' };
      }
    }
    current = await getParentOrgId(current);
  }
  return undefined;
}

/** Resolve {@link OrgAuthority} for `userId` in `orgId`, or undefined when they
 *  hold none. Does not look at `deletedAt` of `orgId` itself — callers refuse a
 *  soft-deleted target org on their own (the token chokepoint does). */
export async function resolveOrgAuthority(userId: string, orgId: string): Promise<OrgAuthority | undefined> {
  const direct = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId), isActive: true }).lean();
  const directRole = direct?.role as OrgMemberRole | undefined;
  if (directRole === 'admin' || directRole === 'owner') {
    return { role: directRole, via: 'membership', permissionOrgIds: [orgId] };
  }
  const inherited = await findAncestorAdminMembership(userId, orgId);
  if (inherited) {
    return {
      role: 'admin',
      via: 'ancestor',
      inheritedFromOrgId: inherited.ancestorOrgId,
      permissionOrgIds: directRole ? [inherited.ancestorOrgId, orgId] : [inherited.ancestorOrgId],
    };
  }
  if (directRole) return { role: directRole, via: 'membership', permissionOrgIds: [orgId] };
  return undefined;
}
