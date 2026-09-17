// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may open an impersonation session, and on what authority.
 *
 * Two callers qualify:
 *   - a platform SYSADMIN, for any user;
 *   - an admin/owner of an org that is a STRICT ANCESTOR of the target user's
 *     org, for users inside their own subtree.
 *
 * The ancestor case exists because a parent org already administers its
 * descendant teams' members, quotas and secrets. Requiring a team to consent to
 * its own parent would invert an authority relationship that already holds
 * everywhere else in the product.
 *
 * NOT admitted: an admin of the target's OWN org. `canAdministerOrg` would allow
 * that (it treats same-org admin as administering authority), but "any org admin
 * may view as any of their members" is a far larger expansion than the parent →
 * team case and has never been decided. `isAncestorOrg` is strict — it returns
 * false when the two orgs are equal — which is exactly the boundary wanted here.
 * Members get nothing in either direction.
 */

import { isSystemAdmin } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { isOrgAdmin } from './controller-helper.js';
import { isAncestorOrg } from './org-hierarchy.js';

export type ImpersonationAuthority =
  /** Platform operator; any target. */
  | { kind: 'sysadmin' }
  /** Admin of an ancestor org reaching into its own subtree. */
  | { kind: 'ancestor'; viaOrgId: string }
  /** Not permitted. */
  | { kind: 'none' };

/**
 * Resolve the authority a caller has to impersonate a user whose session would
 * be pinned to `targetOrgId`.
 *
 * `targetOrgId` is the org the SESSION pins to, not merely where the target
 * happens to be a member — so the authority check and the token's scope describe
 * the same organization. With no pinned org there is no subtree to be inside, so
 * only a sysadmin qualifies.
 */
export async function resolveImpersonationAuthority(
  req: Request,
  targetOrgId: string | undefined,
): Promise<ImpersonationAuthority> {
  if (isSystemAdmin(req)) return { kind: 'sysadmin' };
  if (!isOrgAdmin(req)) return { kind: 'none' };

  const actingOrgId = req.user?.organizationId;
  if (!actingOrgId || !targetOrgId) return { kind: 'none' };

  // Strictly downward: a child admin gets no authority over the parent, and a
  // sibling team is not in the caller's subtree at all.
  if (await isAncestorOrg(actingOrgId, targetOrgId)) {
    return { kind: 'ancestor', viaOrgId: actingOrgId };
  }
  return { kind: 'none' };
}

/**
 * Whether the caller holds genuine TENANT admin authority over `orgId` — an
 * admin/owner of that org or of an ancestor of it.
 *
 * Deliberately does NOT short-circuit for sysadmins, unlike `canAdministerOrg`.
 * That short-circuit is right for managing an org, and exactly wrong for
 * CONSENTING on its behalf: a consent decision belongs to the tenant. If sysadmin
 * status alone conferred it, a sysadmin could open a request and then approve it
 * themselves, and a consent gate would gate nothing.
 */
export async function isTenantAdminOf(req: Request, orgId: string): Promise<boolean> {
  if (!isOrgAdmin(req)) return false;
  const actingOrgId = req.user?.organizationId;
  if (!actingOrgId) return false;
  if (actingOrgId === orgId) return true;
  return isAncestorOrg(actingOrgId, orgId);
}
