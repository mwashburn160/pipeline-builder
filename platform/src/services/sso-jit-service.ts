// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Just-in-time membership + Role provisioning for SSO sign-in (3a).
 *
 * Before this, an SSO sign-in authenticated a user and left them outside the org
 * they had just signed in to: someone had to invite them separately, and their
 * Roles were maintained by hand in two systems. Now the sign-in itself adds the
 * membership and reconciles the Roles their IdP groups map to.
 *
 * The rules, and where each one lives:
 *
 *   SEATS      — the same pooled check the invitation path runs
 *                (`helpers/seats.ts`). Over the limit, the SIGN-IN is refused
 *                (`JIT_SEAT_LIMIT` → 403 with a seat message) rather than handing
 *                out a session with no membership. Checked twice: a pre-flight
 *                BEFORE the identity becomes an account (so a refused sign-in
 *                leaves no orphan user + personal org behind) and the
 *                pre/post-write pair inside the membership transaction.
 *   ENTITLEMENT — JIT lives inside the existing `sso` entitlement, resolved by
 *                the same {@link isSsoEntitled} that gates OIDC SSO today. After
 *                a downgrade this returns `skipped: 'not-entitled'`: nothing is
 *                provisioned and nothing is taken away — existing memberships
 *                and Roles stay exactly as they are.
 *   PLATFORM ADMINS — never provisioned. The SSO login path already refuses them
 *                outright (`SSO_SUPERADMIN_REFUSED`); this is the second, local
 *                gate so the rule holds for any future caller of this service
 *                (SCIM in 3b).
 *   OWNER      — a JIT membership is always created as a plain `member`. Org
 *                ownership is never granted here, and an existing owner is never
 *                demoted (`recomputeUserOrgRole` preserves `owner`).
 *   THIS ORG ONLY — every write is filtered by the SSO org's id. A mapping can
 *                neither add a membership in, nor touch a Role of, any other org.
 *   MANUAL ROLES — `syncMappedRoles` only ever removes assignments it owns
 *                (`source: 'jit'`). A Role an admin granted by hand is never
 *                removed by a sync.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { idpGroupMappingService } from './idp-group-mapping-service.js';
import { JIT_SEAT_LIMIT } from './idp-mapping-errors.js';
import { syncMappedRoles } from './mapped-roles.js';
import { ensureBaselineRole, recomputeUserOrgRole } from './roles-service.js';
import { toOrgId } from '../helpers/org-id.js';
import { seatCapacityAvailable, seatCapacityStillWithinCap, userHasSeatInAccount } from '../helpers/seats.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import { isSsoEntitled } from '../helpers/sso-enforcement.js';
import { User, UserOrganization, type UserDocument } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('sso-jit-service');

/** Why a sign-in provisioned nothing. Never an error — the session still opens
 *  (except for a seat refusal, which throws); the org roster simply doesn't move. */
export type JitSkipReason =
  /** The account is a platform administrator. */
  | 'platform-admin'
  /** The org is not (or no longer) `sso`-entitled. */
  | 'not-entitled'
  /** An admin has deactivated this membership; JIT must not silently undo that. */
  | 'membership-inactive';

export interface JitProvisionResult {
  skipped?: JitSkipReason;
  /** True when this sign-in created the org membership (consumed a seat). */
  membershipCreated: boolean;
  /** Groups from the token that matched a mapping (for the audit trail). */
  matchedGroups: string[];
  /** Role ids the sync added / removed. Both empty on a steady-state sign-in. */
  rolesAdded: string[];
  rolesRemoved: string[];
}

/**
 * Pre-flight seat check, run BEFORE the verified identity is turned into a
 * platform account.
 *
 * `provisionJitMembership` re-checks inside its transaction and is the
 * authoritative gate; this one exists so a sign-in that is going to be refused
 * for seats doesn't first create a user record (and its personal org) that
 * nobody can ever use. Resolves the caller by email — the same way
 * `findOrCreateOAuthUser` links them — and skips the check entirely when they
 * already hold a seat in the account (seats count DISTINCT humans).
 *
 * Throws `JIT_SEAT_LIMIT`.
 */
export async function assertJitSeatAvailable(orgId: string, email: string): Promise<void> {
  const existing = await User.findOne({ email: email.toLowerCase() }).select('_id').lean();
  if (existing && await userHasSeatInAccount(existing._id, orgId)) return;
  if (!(await seatCapacityAvailable(orgId, 1))) throw new Error(JIT_SEAT_LIMIT);
}

/**
 * Add `user` to `orgId` (if they aren't already a member) and reconcile the
 * Roles their IdP `groups` map to.
 *
 * NOTE ON `user`: a Role/membership change bumps `claimsVersion`, which would
 * invalidate a token minted from the now-stale in-memory document. This refreshes
 * `user.claimsVersion` (and `tokenVersion`) in place after committing, so the caller can hand the SAME
 * document to `issueTokens` and get a session that is valid from the first
 * request. Callers must not mint tokens from a copy taken before this call.
 *
 * Throws `JIT_SEAT_LIMIT`; every other outcome is reported in the result.
 */
export async function provisionJitMembership(input: {
  orgId: string;
  user: UserDocument;
  groups: readonly string[];
}): Promise<JitProvisionResult> {
  const { orgId, user, groups } = input;
  const none: JitProvisionResult = { membershipCreated: false, matchedGroups: [], rolesAdded: [], rolesRemoved: [] };

  // Platform administrators are never provisioned into a customer org — their
  // authority does not come from, and must not be shaped by, a tenant's IdP.
  if (user.isSuperAdmin === true) {
    incCounter('platform_sso_jit_refused_total', { reason: 'platform_admin' });
    return { ...none, skipped: 'platform-admin' };
  }

  // JIT rides the SSO entitlement. After a downgrade this is the off-switch:
  // nothing is provisioned, and nothing already granted is withdrawn.
  if (!(await isSsoEntitled(orgId))) {
    incCounter('platform_sso_jit_refused_total', { reason: 'not_entitled' });
    return { ...none, skipped: 'not-entitled' };
  }

  const { roleIds, matchedGroups } = await idpGroupMappingService.resolveMappedRoles(orgId, groups);
  const oid = toOrgId(orgId);

  const result = await withMongoTransaction(async (session): Promise<JitProvisionResult> => {
    const membership = await UserOrganization.findOne({ userId: user._id, organizationId: oid }).session(session);

    // A deactivated membership is an administrator's decision. Re-activating it
    // because the IdP still knows the user would quietly override that, so JIT
    // leaves the account alone (and grants nothing) until an admin reactivates.
    if (membership && !membership.isActive) {
      return { ...none, skipped: 'membership-inactive' as JitSkipReason };
    }

    let membershipCreated = false;
    let consumedSeat = false;
    if (!membership) {
      // Seats pool at the account root and count distinct humans, so someone who
      // is already active elsewhere in the account costs nothing to add here.
      const alreadySeated = await userHasSeatInAccount(user._id, orgId, session);
      if (!alreadySeated && !(await seatCapacityAvailable(orgId, 1, session))) {
        throw new Error(JIT_SEAT_LIMIT);
      }
      consumedSeat = !alreadySeated;

      // Always a plain member: a mapping may raise the effective role through an
      // admin-granting Role below, but ownership is never provisioned.
      await UserOrganization.create([{ userId: user._id, organizationId: oid, role: 'member' }], { session });
      // Single-source RBAC: the built-in Member floor, or the membership would
      // resolve to zero permissions. It is stamped `manual`, so a later sync
      // never strips it.
      await ensureBaselineRole(user._id, oid, session);
      membershipCreated = true;
    }

    const { added, removed } = await syncMappedRoles(oid, user._id, roleIds, session);

    // Recompute the cached coarse role from the resulting Role set (preserves
    // `owner`, derives `admin` from an admin-granting mapped Role) and force a
    // token reissue when the effective grants moved, so the user's OTHER live
    // sessions can't keep acting on the Roles the IdP just took away.
    if (membershipCreated || added.length > 0 || removed.length > 0) {
      await recomputeUserOrgRole(user._id, oid, session);
      await User.updateOne({ _id: user._id }, { $inc: { claimsVersion: 1 } }, { session });
    }

    // Post-write re-check (the G5 pattern the invite/add paths run): a concurrent
    // sign-in or invite that slipped between the pre-check and this insert must
    // not leave the account over its pooled cap.
    if (consumedSeat && !(await seatCapacityStillWithinCap(orgId, session))) {
      throw new Error(JIT_SEAT_LIMIT);
    }

    return { membershipCreated, matchedGroups, rolesAdded: added, rolesRemoved: removed };
  });

  if (result.skipped) return result;

  const changed = result.membershipCreated || result.rolesAdded.length > 0 || result.rolesRemoved.length > 0;
  if (changed) {
    // Re-read the version we just bumped so the session about to be minted from
    // `user` carries the CURRENT one (see the note on this function).
    const fresh = await User.findById(user._id).select('+tokenVersion').lean();
    if (fresh && typeof fresh.tokenVersion === 'number') user.tokenVersion = fresh.tokenVersion;
    if (fresh && typeof fresh.claimsVersion === 'number') user.claimsVersion = fresh.claimsVersion;
    // Post-commit: publish it so the stateless services drop the user's older
    // access tokens immediately (best-effort).
    await publishUserRevocation(String(user._id));

    incCounter('platform_sso_jit_provisioned_total', { outcome: result.membershipCreated ? 'created' : 'updated' });
    logger.info('[JIT] provisioned SSO member', {
      orgId,
      userId: String(user._id),
      membershipCreated: result.membershipCreated,
      matchedGroups: result.matchedGroups.length,
      rolesAdded: result.rolesAdded.length,
      rolesRemoved: result.rolesRemoved.length,
    });
  }
  return result;
}
