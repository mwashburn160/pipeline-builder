// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { authService } from './auth-service.js';
import { loadActiveOrgInfo } from '../helpers/active-org-info.js';
import { publishUserRevocation, publishUserDeletionRevocation } from '../helpers/session-revocation.js';
import { User, Organization, UserOrganization, Role, RoleAssignment } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('user-profile-service');

/** Domain error codes thrown by service methods. */
export const PROFILE_USER_NOT_FOUND = 'PROFILE_USER_NOT_FOUND';
export const PROFILE_EMAIL_TAKEN = 'PROFILE_EMAIL_TAKEN';
export const PROFILE_INVALID_CREDENTIALS = 'PROFILE_INVALID_CREDENTIALS';
export const PROFILE_OWNER_HAS_ORGS = 'PROFILE_OWNER_HAS_ORGS';
export const PROFILE_LAST_PRIVILEGED_MEMBER = 'PROFILE_LAST_PRIVILEGED_MEMBER';

interface OrgInfo {
  id: string;
  name: string;
  slug?: string;
  tier?: string;
  /** Account-level feature entitlements (e.g. add-on bundle grants). */
  featureEntitlements?: string[];
}

interface MembershipInfo {
  organizationId: string;
  organizationName: string;
  slug?: string;
  role: string;
  isActive: boolean;
  joinedAt?: string;
  /** Parent org id when this org is a team (org → team hierarchy); omitted for root orgs. */
  parentOrgId?: string;
  /** Org's quota tier — lets the UI gate tier-gated actions (e.g. only team/enterprise roots may parent teams). */
  tier?: string;
}

interface ProfileData {
  user: Awaited<ReturnType<typeof User.findById>> extends infer U
    ? U extends null ? never : NonNullable<U>
    : never;
  /** Per-org join records for the user. */
  memberships: Array<{
    organizationId: Types.ObjectId | string;
    role: string;
  }>;
  /** Lookup map from org-id → name/tier for callers that mix the two. */
  orgMap: Map<string, OrgInfo>;
}

class UserProfileService {
  /**
   * Resolve the user + their org memberships + a name/tier lookup for the
   * orgs they belong to. One round-trip per logical fetch (user, memberships,
   * orgs) so the controller can shape its response without further DB calls.
   * Throws PROFILE_USER_NOT_FOUND when the user record is gone.
   */
  async getProfileWithOrgs(userId: string): Promise<ProfileData> {
    const user = await User.findById(userId)
      // isSuperAdmin must be selected here — formatUserResponse echoes
      // it to /api/user/profile so the frontend can gate sysadmin-only
      // sidebar entries. Without it in the projection, the API always
      // returned isSuperAdmin: false regardless of mongo state.
      .select('_id username email isEmailVerified isSuperAdmin lastActiveOrgId featureOverrides tokenVersion')
      .lean();
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);

    const memberships = await UserOrganization.find({ userId: user._id }).lean();
    const orgIds = memberships.map(m => m.organizationId);
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name slug tier featureEntitlements').lean()
      : [];

    const orgMap = new Map<string, OrgInfo>(
      orgs.map(o => [o._id.toString(), { id: o._id.toString(), name: o.name, slug: o.slug, tier: o.tier, featureEntitlements: o.featureEntitlements }]),
    );

    return { user: user as never, memberships, orgMap };
  }

  /**
   * Return all org memberships for a user as a flat array, sorted by
   * `joinedAt` (oldest first — keeps "Personal org" at the top of the
   * dashboard switcher).
   */
  async listOrganizations(userId: string): Promise<MembershipInfo[]> {
    const memberships = await UserOrganization.find({ userId }).sort({ joinedAt: 1 }).lean();
    const orgIds = memberships.map(m => m.organizationId);
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name slug parentOrgId tier').lean()
      : [];
    const orgMap = new Map(orgs.map(o => [o._id.toString(), o]));

    return memberships.map(m => {
      const org = orgMap.get(m.organizationId.toString());
      const parentOrgId = org?.parentOrgId ? String(org.parentOrgId) : undefined;
      return {
        organizationId: m.organizationId.toString(),
        organizationName: org?.name || 'Unknown',
        slug: org?.slug,
        role: m.role,
        isActive: m.isActive,
        joinedAt: m.joinedAt?.toISOString(),
        ...(parentOrgId && { parentOrgId }),
        ...(org?.tier && { tier: org.tier as string }),
      };
    });
  }

  /**
   * Update username and/or email on the user record. Email change clears
   * `isEmailVerified` so the user re-verifies. Throws PROFILE_EMAIL_TAKEN when
   * the new email is already in use, PROFILE_USER_NOT_FOUND when the user is gone.
   */
  async updateProfile(userId: string, body: { username?: string; email?: string }) {
    const updates: Partial<{ username: string; email: string; isEmailVerified: boolean }> = {};
    if (body.username) updates.username = body.username.trim().toLowerCase();
    if (body.email) updates.email = body.email.trim().toLowerCase();

    if (updates.email) {
      const existing = await User.findOne({
        email: updates.email,
        _id: { $ne: new Types.ObjectId(userId) },
      });
      if (existing) throw new Error(PROFILE_EMAIL_TAKEN);
      updates.isEmailVerified = false;
    }

    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { returnDocument: 'after', runValidators: true },
    ).lean();
    if (!updated) throw new Error(PROFILE_USER_NOT_FOUND);

    const { organizationName, activeOrgRole } = await loadActiveOrgInfo(updated._id, updated.lastActiveOrgId?.toString());
    return { user: updated, organizationName, activeOrgRole };
  }

  /**
   * Delete the user account + all their UserOrganization rows.
   * Refuses if the user owns any orgs (transfer ownership first); throws
   * PROFILE_OWNER_HAS_ORGS in that case, PROFILE_USER_NOT_FOUND if the user is already gone.
   */
  async deleteAccount(userId: string): Promise<void> {
    const uid = new Types.ObjectId(userId);
    let capturedTokenVersion = 0;
    // Membership + role assignments + user deleted atomically (mirrors admin
    // deleteUserById) — otherwise a partial failure orphans RoleAssignment rows,
    // which the last-privileged-member guard counts and would then wrongly block
    // removing the last real member of a privileged role. The owner and
    // last-privileged-member guard READS also run inside the tx (was a
    // check-then-act TOCTOU when read before it), so they see a snapshot
    // consistent with the delete.
    const existed = await withMongoTransaction(async (session) => {
      const ownerCount = await UserOrganization.countDocuments({ userId: uid, role: 'owner' }).session(session);
      if (ownerCount > 0) throw new Error(PROFILE_OWNER_HAS_ORGS);

      // Don't let self-delete empty an admin/superadmin-granting Role (last member).
      const assignments = await RoleAssignment.find({ userId: uid }).select('roleId').session(session).lean();
      for (const a of assignments) {
        const role = await Role.findById(a.roleId).select('grantsRole').session(session).lean();
        if (role && role.grantsRole !== 'member' && (await RoleAssignment.countDocuments({ roleId: a.roleId }).session(session)) <= 1) {
          throw new Error(PROFILE_LAST_PRIVILEGED_MEMBER);
        }
      }

      // Capture tokenVersion from the deleted doc to revoke outstanding tokens.
      const result = await User.findByIdAndDelete(userId, { session }).select('+tokenVersion');
      if (!result) return false;
      capturedTokenVersion = result.tokenVersion ?? 0;
      await UserOrganization.deleteMany({ userId: uid }, { session });
      await RoleAssignment.deleteMany({ userId: uid }, { session });
      return true;
    });
    if (!existed) throw new Error(PROFILE_USER_NOT_FOUND);
    // Revoke the deleted user's outstanding tokens on the stateless services.
    await publishUserDeletionRevocation(userId, capturedTokenVersion);
    logger.info('Account deleted', { userId });
  }

  /**
   * Verify the current password and update to the new one. Bumps
   * `tokenVersion` so all existing access tokens are immediately invalid.
   * Throws PROFILE_USER_NOT_FOUND or PROFILE_INVALID_CREDENTIALS.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await User.findById(userId).select('+password +tokenVersion');
    if (!user || !user.password) throw new Error(PROFILE_USER_NOT_FOUND);

    if (!await user.comparePassword(currentPassword)) throw new Error(PROFILE_INVALID_CREDENTIALS);

    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();
    // Post-commit: publish the now-current tokenVersion so the stateless services
    // reject every outstanding token immediately (best-effort).
    await publishUserRevocation(String(userId));
  }

  /** Fetch a user with `tokenVersion` AND `isSuperAdmin` selected, suitable
   *  for issuing tokens. Both fields are `select: false` on the schema, and
   *  `issueTokens` -> `createAccessTokenPayload` reads `user.isSuperAdmin`
   *  to bake the sysadmin claim into the JWT. Omitting `+isSuperAdmin` here
   *  silently mints non-sysadmin tokens for promoted users (e.g. when a
   *  sysadmin clicks "regenerate API token" on the dashboard). */
  async findForTokenIssue(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion +isSuperAdmin');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    return user;
  }

  /**
   * Return the user's recent token-issuance history with status computed
   * per token: expired if past expiry, revoked if tokenVersion bumped past
   * the issue-time value, otherwise active. JWT is stateless so revocation
   * is derived from `user.tokenVersion`, not stored per-token.
   */
  async listTokenHistory(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion issuedTokens');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);

    const now = Date.now();
    return (user.issuedTokens ?? []).map((t) => {
      const expiresAt = t.expiresAt instanceof Date ? t.expiresAt : new Date(t.expiresAt);
      const createdAt = t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt);
      let status: 'active' | 'expired' | 'revoked';
      if (expiresAt.getTime() <= now) status = 'expired';
      else if (t.tokenVersionAtIssue !== user.tokenVersion) status = 'revoked';
      else status = 'active';
      return {
        id: t.id,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status,
      };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * "Sign out everywhere" — routes through `authService.invalidateAllSessions`,
   * the SAME path auth logout uses, so the profile "revoke all" behaves
   * identically: bump `tokenVersion`, CLEAR the stored `refreshToken` hash, AND
   * publish the revocation to the stateless services. (It previously called the
   * model's `invalidateAllSessions()`, which only bumped `tokenVersion` and left
   * the stored refresh-token hash valid — a divergence masked only because the
   * refresh path also re-checks `tokenVersion`.) Returns the user with
   * `tokenVersion` selected so the caller can issue a fresh replacement token.
   */
  async revokeAllSessions(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion issuedTokens');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    // Authoritative "sign out everywhere": $inc tokenVersion + $unset refreshToken
    // in the DB and publish the revocation (best-effort) — all inside the service.
    await authService.invalidateAllSessions(String(userId));
    // The service bumped tokenVersion via $inc in the DB; mirror that on the doc
    // we return so the caller mints the replacement token at the new version.
    user.tokenVersion += 1;
    return user;
  }
}

export const userProfileService = new UserProfileService();
