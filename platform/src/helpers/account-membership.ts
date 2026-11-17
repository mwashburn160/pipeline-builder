// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a person stands relative to an ACCOUNT (an org's root plus every team
 * under it), and whether an account admin may act on them without asking.
 *
 * An account's admins administer the people IN their account. They do not
 * administer a person merely because that person exists on the platform, and
 * they do not administer what a person does in OTHER accounts. Two decisions
 * rest on that line:
 *
 *  - DIRECT ADD (`POST /organization/:id/members`, `.../members/bulk-add`):
 *    putting someone into the account with nothing for them to accept is only
 *    acceptable when they are already in it (they accepted an invitation, were
 *    provisioned, or joined at some point) or when the account has proven it
 *    owns their address's domain — the exact authority rule SCIM provisioning
 *    and SSO trust use (`ownsVerifiedDomain`). Anyone else gets an invitation,
 *    which they can decline.
 *  - ANCESTOR IMPERSONATION: a parent admin views a team member without asking,
 *    because the parent already administers that team. That carve-out must not
 *    reach a person who also belongs to orgs OUTSIDE the parent's account — the
 *    session would expose their presence elsewhere, and their membership here
 *    may itself be the product of a direct add.
 *
 * Every read is fail-CLOSED toward "outside / not consented": an unreadable
 * lineage asks for consent rather than skipping it.
 */

import type { ClientSession, Types } from 'mongoose';
import { expandOrgScope, resolveOrgLineage } from './org-hierarchy.js';
import { toOrgId } from './org-id.js';
import { UserOrganization } from '../models/index.js';
import { OM_CONSENT_REQUIRED } from '../services/org-members-errors.js';
import type { RoleAssignmentActor } from '../services/role-authority.js';

type UserId = Types.ObjectId | string;

/** Every org id in `orgId`'s account: its root and the root's whole subtree. */
export async function accountScopeOf(orgId: string): Promise<string[]> {
  const { rootOrgId } = await resolveOrgLineage(orgId);
  return expandOrgScope(rootOrgId);
}

/**
 * Whether `userId` holds ANY membership (active or deactivated) in `orgId`'s
 * account. A deactivated membership still records that the person entered the
 * account by their own acceptance; it is the account's to reactivate.
 */
export async function hasMembershipInAccount(
  userId: UserId,
  orgId: string,
  session?: ClientSession | null,
): Promise<boolean> {
  const scope = (await accountScopeOf(orgId)).map(toOrgId);
  return !!(await UserOrganization.exists({ userId, organizationId: { $in: scope } }).session(session ?? null));
}

/**
 * Whether `userId` belongs to any org OUTSIDE `orgId`'s account. Fails closed:
 * when the account cannot be resolved the answer is `true`, so the caller asks
 * for consent instead of assuming the person is wholly inside the tenant.
 */
export async function hasMembershipOutsideAccount(userId: UserId, orgId: string): Promise<boolean> {
  let scope: string[];
  try {
    scope = await accountScopeOf(orgId);
  } catch {
    return true;
  }
  return !!(await UserOrganization.exists({ userId, organizationId: { $nin: scope.map(toOrgId) } }));
}

/**
 * Refuse a DIRECT add of `user` into `orgId`'s account that the person never
 * agreed to. Allowed when:
 *   - the actor is a platform superadmin (the operator, who already holds every
 *     cross-tenant authority this could launder);
 *   - the person already has a membership somewhere in this account; or
 *   - the account (the org or its root) has VERIFIED the domain of the person's
 *     email — the SCIM / SSO authority rule.
 * Otherwise throws `OM_CONSENT_REQUIRED`: the admin should send an invitation.
 */
export async function assertDirectAddConsented(input: {
  user: { _id: UserId; email?: string | null };
  orgId: string;
  actor: RoleAssignmentActor;
  session?: ClientSession | null;
}): Promise<void> {
  if (input.actor.isSuperAdmin) return;
  if (await hasMembershipInAccount(input.user._id, input.orgId, input.session)) return;

  // Imported on demand: sso-enforcement's static graph (IdP services, config)
  // is far wider than the member service's, which several suites keep narrow.
  const { emailDomain, ownsVerifiedDomain } = await import('./sso-enforcement.js');
  const domain = input.user.email ? emailDomain(input.user.email) : null;
  if (domain && await ownsVerifiedDomain(input.orgId, domain)) return;

  throw new Error(OM_CONSENT_REQUIRED);
}
