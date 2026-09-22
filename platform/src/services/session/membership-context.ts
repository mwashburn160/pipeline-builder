// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org context a user token is minted against: which org is active, the
 * person's authority there (a membership row or admin authority inherited from
 * an ancestor), the Roles' permissions, the org's MFA policy and the
 * account-level entitlements and hierarchy claims.
 */

import { createLogger, type QuotaTier } from '@pipeline-builder/api-core';
import { type EffectiveMfaPolicy, resolveEffectiveMfaPolicy } from '../../helpers/mfa-policy.js';
import { resolveOrgAuthority } from '../../helpers/org-authority.js';
import { resolveOrgLineage } from '../../helpers/org-hierarchy.js';
import { toOrgId } from '../../helpers/org-id.js';
import { Organization, UserOrganization } from '../../models/index.js';
import type { OrgMemberRole } from '../../models/user-organization.js';
import { rolePermissionsFor } from '../role-permissions.js';

const logger = createLogger('token');

/** Membership context for token payload. */
export interface MembershipContext {
  organizationId: string;
  organizationName?: string;
  role: OrgMemberRole;
  tier?: QuotaTier;
  /** Org → team hierarchy: direct parent of the active org (omitted for root orgs). */
  parentOrganizationId?: string;
  /** Org → team hierarchy: root of the active org's ancestry chain (omitted for root orgs). */
  rootOrganizationId?: string;
  /** Account-level purchased feature entitlements (bundles), propagated onto the
   *  active org; unioned into the resolved feature set. */
  featureEntitlements?: readonly string[];
  /** Fine-grained permissions granted by the Roles the user holds in the active
   *  org — the union of those Roles' `permissions[]`. This IS the JWT
   *  `permissions` claim (single-source; superadmin ⇒ all). */
  rolePermissions?: readonly string[];
  /** The org (or an ancestor) requires MFA — resolved once here and carried
   *  as the `mfaRequired` claim. */
  mfaRequired?: boolean;
  /** The requirement is past its grace period, so a session scoped to this org
   *  must be `aal: 2` or be refused at issuance. */
  mfaEnforced?: boolean;
  /** The org (or an ancestor) requires MFA for administrative actions — carried
   *  as the `org_admin_aal: 2` claim. */
  adminActionsRequireMfa?: boolean;
}

/**
 * Membership context for ONE specific org, or `undefined` when the user has no
 * live membership there (nor admin authority inherited from an ancestor). No
 * fallback to any other org — see {@link resolveMembership} for the login path
 * that does fall back, and `issueImpersonationToken` for the caller that must NOT.
 */
export async function resolveOrgMembership(userId: string, orgId: string): Promise<MembershipContext | undefined> {
  // A live membership row OR admin authority inherited from an ancestor org (a
  // parent admin working inside a team) — see helpers/org-authority.ts.
  const authority = await resolveOrgAuthority(userId, orgId);
  if (!authority) return undefined;
  const org = await Organization.findById(toOrgId(orgId)).select('name tier parentOrgId featureEntitlements deletedAt').lean();
  // CHOKEPOINT: refuse to scope a token to a SOFT-DELETED org. The org is
  // being torn down (retention window) — treat it as gone. Combined with the
  // tokenVersion bump on soft-delete, this cuts off ALL access to the org
  // without any per-read `deletedAt` filtering elsewhere.
  if (!org || org.deletedAt) return undefined;
  // Org policy "require MFA". Resolved HERE — the one place a token's
  // active org is established — so every issuance path (sign-in, refresh,
  // renewal, switch-org, key exchange) sees the same answer; it is ENFORCED in
  // one place too (`enforceOrgAssurance`), which both session issuance and the
  // key exchange call. A read failure degrades to "no requirement" rather
  // than refusing every sign-in for the account; the policy is a hardening
  // measure, not a kill switch.
  let mfa: EffectiveMfaPolicy | undefined;
  try {
    mfa = await resolveEffectiveMfaPolicy(orgId);
  } catch (error) {
    logger.warn('MFA policy read failed; treating the org as not requiring MFA', { orgId, error });
  }
  return {
    organizationId: orgId,
    organizationName: org.name,
    role: authority.role,
    tier: org.tier,
    rolePermissions: await rolePermissionsFor(userId, authority.permissionOrgIds),
    ...(mfa?.requireMfa ? { mfaRequired: true } : {}),
    ...(mfa?.enforced ? { mfaEnforced: true } : {}),
    ...(mfa?.adminActionsRequireMfa ? { adminActionsRequireMfa: true } : {}),
    ...(await accountContext(orgId, org)),
  };
}

/**
 * Resolve the membership context for a user's active organization: the pinned
 * `activeOrgId` when it is still a live membership, else the earliest active
 * membership whose org is live. A user whose active org was just soft-deleted
 * lands on another live org (or nothing), never back on the dying one.
 */
export async function resolveMembership(userId: string, activeOrgId?: string): Promise<MembershipContext | undefined> {
  if (activeOrgId) {
    const pinned = await resolveOrgMembership(userId, activeOrgId);
    if (pinned) return pinned;
  }
  const memberships = await UserOrganization.find({ userId, isActive: true }).sort({ joinedAt: 1 }).lean();
  for (const m of memberships) {
    const orgId = m.organizationId.toString();
    if (orgId === activeOrgId) continue; // already tried above
    const context = await resolveOrgMembership(userId, orgId);
    if (context) return context;
  }
  return undefined;
}

/**
 * Resolve the account-level context a token bakes in for its active org: the
 * authoritative `featureEntitlements` set PLUS the org → team hierarchy claims.
 *
 * `featureEntitlements` and the tier POOL AT THE ACCOUNT ROOT; billing writes
 * them there and the platform propagates them onto descendant teams. A team's
 * own doc therefore carries only a DENORMALIZED copy that can lag propagation
 * (concurrent team-create, a partially-applied propagation write). To keep the
 * JWT structurally drift-proof we read the entitlements from the ROOT for a
 * parented org — mirroring `pooledFeatureEntitlements` — rather than trusting
 * the active team doc's copy.
 *
 * When the active org is flat (no `parentOrgId`, the case for every org today)
 * the active doc IS the root: its own `featureEntitlements` are authoritative,
 * no hierarchy claims apply, and this costs NO extra DB round-trip. Only a
 * parented org pays a single lineage walk ({@link resolveOrgLineage}) — reused
 * for both the hierarchy claims and the root entitlement read.
 */
async function accountContext(
  orgId: string,
  org: { parentOrgId?: string | null; featureEntitlements?: string[] },
): Promise<{
    featureEntitlements?: readonly string[];
    parentOrganizationId?: string;
    rootOrganizationId?: string;
  }> {
  // Flat/root org: the active doc is the root — trust its own copy, no read.
  if (!org.parentOrgId) return { featureEntitlements: org.featureEntitlements };

  // Parented org (team): resolve lineage ONCE, then read the ROOT's authoritative
  // entitlements (drift-proof) and derive the hierarchy claims from the same walk.
  const lineage = await resolveOrgLineage(orgId);
  // The ROOT read is a NEWLY-INTRODUCED failure surface for a team login (before
  // drift-proofing a team never read the root). A transient root-read blip must
  // NOT propagate out — resolveMembership's caller (`issueTokens`) would then
  // swallow it and strand the member with NO org context (default developer /
  // no-perms), a far worse outcome than slightly-stale entitlements. So GRACEFULLY
  // DEGRADE to the team doc's own denormalized `featureEntitlements` (already in
  // hand) — the JWT carries the possibly-stale team-doc set rather than collapsing
  // the whole membership. The hierarchy claims still ride the same lineage walk.
  let featureEntitlements: readonly string[] = org.featureEntitlements ?? [];
  try {
    const root = await Organization.findById(toOrgId(lineage.rootOrgId))
      .select('featureEntitlements').lean();
    featureEntitlements = (root as { featureEntitlements?: string[] })?.featureEntitlements ?? [];
  } catch (error) {
    logger.warn('accountContext: root featureEntitlements read failed; degrading to team-doc copy', {
      orgId,
      rootOrgId: lineage.rootOrgId,
      error,
    });
  }
  return {
    featureEntitlements,
    ...(lineage.parentOrgId && { parentOrganizationId: lineage.parentOrgId }),
    ...(lineage.rootOrgId !== orgId && { rootOrganizationId: lineage.rootOrgId }),
  };
}

/**
 * The membership context an access key's exchanged token is minted against —
 * exported so the key service can fail closed when it resolves to `undefined`
 * for a key that names an org.
 */
export async function membershipForOrg(userId: string, orgId: string): Promise<MembershipContext | undefined> {
  return resolveOrgMembership(userId, orgId);
}
