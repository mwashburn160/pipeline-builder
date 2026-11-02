// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may open an impersonation session, and on what authority.
 *
 * Two callers qualify, and the two are NOT the same kind of act, so each has its
 * own permission:
 *
 *  - the VENDOR, for any user: a member of the SYSTEM org holding
 *    `impersonation:open` (a superadmin holds it implicitly). Cross-tenant, and
 *    therefore still subject to the target organisation's consent policy.
 *  - a PARENT org's admin/owner holding `team_access:open`, for users inside its
 *    own subtree. Never leaves the tenant.
 *
 * WHY A PERMISSION AND NOT THE FLAG. Impersonation was the last authority in the
 * product resolved purely from role bits: `isSystemAdmin(req)` on the vendor
 * side and `isOrgAdmin(req)` on the tenant side. On the vendor side that meant
 * the only way to let a support lead view a customer's account was to make them
 * a full Super Admin — which also grants `/admin/users/:id/grants`, the
 * single-person MFA reset, a database shell and `registry:purge`. On the tenant
 * side it meant a parent org could neither withhold team access from one of its
 * admins nor delegate it to a lead who is not one.
 *
 * THE SYSTEM-ORG CHECK IS LOAD-BEARING. `team_access:open` is org-assignable, so
 * any tenant admin may hold it; `impersonation:open` is system-org-only, so no
 * tenant Role can. The vendor branch below ALSO requires the caller's active org
 * to be the system org, because a permission claim alone must never be able to
 * carry a tenant across the boundary — and `confinePermissionsToOrg` already
 * strips system-org-only ids from any token whose active org is a tenant, which
 * makes this a second, independent fence rather than the only one.
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
 *
 * NOT covered here at all: emergency access. `breakglass` walks past tenant
 * consent, so it stays on the superadmin flag and is approved by a SECOND
 * superadmin; it does not consult this resolver.
 */

import { isSystemOrgId, userHasPermission } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { isOrgAdmin } from './controller-helper.js';
import { isAncestorOrg } from './org-hierarchy.js';

export type ImpersonationAuthority =
  /** The vendor: system-org `impersonation:open`; any target. */
  | { kind: 'platform' }
  /** Admin of an ancestor org, holding `team_access:open`, reaching into its own subtree. */
  | { kind: 'ancestor'; viaOrgId: string }
  /** Not permitted. */
  | { kind: 'none' };

/**
 * The vendor-side half: a member of the system org holding `impersonation:open`.
 *
 * Both halves are required. A superadmin satisfies the permission implicitly
 * (`userHasPermission` honours `isSuperAdmin`), so the flag keeps working
 * without being the only path.
 */
export function hasPlatformImpersonationAuthority(req: Request): boolean {
  // BOTH spellings, as `isOrgAdmin` does: the system org is identified by its
  // id (a 24-hex ObjectId) or by its `system` slug, and a token may carry
  // either. Passing only the id silently refuses a caller identified by name.
  const inSystemOrg = isSystemOrgId(req.user?.organizationId, req.user?.organizationName);
  return inSystemOrg && userHasPermission(req, 'impersonation:open');
}

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
  if (hasPlatformImpersonationAuthority(req)) return { kind: 'platform' };
  // The tenant half needs BOTH the coarse admin label (ownership of the subtree)
  // and the permission, so an org can withhold it from an admin via a custom
  // Role or hand it to a lead who is not one.
  if (!isOrgAdmin(req) || !userHasPermission(req, 'team_access:open')) return { kind: 'none' };

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
 *
 * It also requires `impersonation:approve`, which is in the admin and owner
 * bundles — so every org admin keeps the authority they have today, and an org
 * that wants the decision to rest with one named person can now author a Role
 * that says so. Answering a consent request is a bigger act than configuring the
 * policy that decides whether consent is needed, and until this existed only the
 * smaller one (`org_impersonation:write`) had a permission of its own.
 *
 * NOTE the deliberate asymmetry with the named approver: a request routed to a
 * specific user is decided by THAT user regardless of this permission (see
 * `decideImpersonationRequest`). They were asked personally; the permission
 * governs who may answer on the organisation's behalf when nobody was.
 */
export async function isTenantAdminOf(req: Request, orgId: string): Promise<boolean> {
  if (!isOrgAdmin(req) || !userHasPermission(req, 'impersonation:approve')) return false;
  const actingOrgId = req.user?.organizationId;
  if (!actingOrgId) return false;
  if (actingOrgId === orgId) return true;
  return isAncestorOrg(actingOrgId, orgId);
}
