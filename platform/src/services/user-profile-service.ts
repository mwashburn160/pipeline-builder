// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { User, Organization, UserOrganization } from '../models';

const logger = createLogger('UserProfileService');

/** Domain error codes thrown by service methods. */
export const PROFILE_USER_NOT_FOUND = 'PROFILE_USER_NOT_FOUND';
export const PROFILE_EMAIL_TAKEN = 'PROFILE_EMAIL_TAKEN';
export const PROFILE_INVALID_CREDENTIALS = 'PROFILE_INVALID_CREDENTIALS';
export const PROFILE_OWNER_HAS_ORGS = 'PROFILE_OWNER_HAS_ORGS';

interface OrgInfo {
  id: string;
  name: string;
  slug?: string;
  tier?: string;
}

interface MembershipInfo {
  organizationId: string;
  organizationName: string;
  slug?: string;
  role: string;
  isActive: boolean;
  joinedAt?: string;
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
      .select('_id username email isEmailVerified lastActiveOrgId featureOverrides tokenVersion')
      .lean();
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);

    const memberships = await UserOrganization.find({ userId: user._id }).lean();
    const orgIds = memberships.map(m => m.organizationId);
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name slug tier').lean()
      : [];

    const orgMap = new Map<string, OrgInfo>(
      orgs.map(o => [o._id.toString(), { id: o._id.toString(), name: o.name, slug: o.slug, tier: o.tier }]),
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
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name slug').lean()
      : [];
    const orgMap = new Map(orgs.map(o => [o._id.toString(), o]));

    return memberships.map(m => {
      const org = orgMap.get(m.organizationId.toString());
      return {
        organizationId: m.organizationId.toString(),
        organizationName: org?.name || 'Unknown',
        slug: org?.slug,
        role: m.role,
        isActive: m.isActive,
        joinedAt: m.joinedAt?.toISOString(),
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

    // Fetch active org name + role in parallel for response shaping.
    const activeOrgId = updated.lastActiveOrgId?.toString();
    let organizationName: string | null = null;
    let activeOrgRole: string | undefined;

    if (activeOrgId) {
      const [org, membership] = await Promise.all([
        Organization.findById(activeOrgId).select('name').lean(),
        UserOrganization.findOne({ userId: updated._id, organizationId: activeOrgId, isActive: true }).lean(),
      ]);
      organizationName = org?.name || null;
      activeOrgRole = membership?.role;
    }

    return { user: updated, organizationName, activeOrgRole };
  }

  /**
   * Delete the user account + all their UserOrganization rows.
   * Refuses if the user owns any orgs (transfer ownership first); throws
   * PROFILE_OWNER_HAS_ORGS in that case, PROFILE_USER_NOT_FOUND if the user is already gone.
   */
  async deleteAccount(userId: string): Promise<void> {
    const ownerCount = await UserOrganization.countDocuments({
      userId: new Types.ObjectId(userId),
      role: 'owner',
    });
    if (ownerCount > 0) throw new Error(PROFILE_OWNER_HAS_ORGS);

    const result = await User.findByIdAndDelete(userId);
    if (!result) throw new Error(PROFILE_USER_NOT_FOUND);

    await UserOrganization.deleteMany({ userId: new Types.ObjectId(userId) });
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
  }

  /** Fetch a user with `tokenVersion` selected, suitable for issuing tokens. */
  async findForTokenIssue(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion');
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
   * "Sign out everywhere" — calls the model's `invalidateAllSessions()`
   * which bumps tokenVersion. Returns the user (still with tokenVersion
   * selected) so the caller can issue a fresh replacement token.
   */
  async revokeAllSessions(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion issuedTokens');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    await user.invalidateAllSessions();
    return user;
  }
}

export const userProfileService = new UserProfileService();
