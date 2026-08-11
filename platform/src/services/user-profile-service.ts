// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createLogger } from '@pipeline-builder/api-core';
import type { TokenScope } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { authService } from './auth-service.js';
import { loadActiveOrgInfo } from '../helpers/active-org-info.js';
import { publishUserRevocation, publishUserDeletionRevocation } from '../helpers/session-revocation.js';
import { User, Organization, UserOrganization, Role, RoleAssignment, PersonalAccessToken, type PersonalAccessTokenDocument, UserPreferences } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';
import { signPersonalAccessToken } from '../utils/token.js';

const logger = createLogger('user-profile-service');

/** Domain error codes thrown by service methods. */
export const PROFILE_USER_NOT_FOUND = 'PROFILE_USER_NOT_FOUND';
export const PROFILE_EMAIL_TAKEN = 'PROFILE_EMAIL_TAKEN';
export const PROFILE_INVALID_CREDENTIALS = 'PROFILE_INVALID_CREDENTIALS';
export const PROFILE_OWNER_HAS_ORGS = 'PROFILE_OWNER_HAS_ORGS';
export const PROFILE_LAST_PRIVILEGED_MEMBER = 'PROFILE_LAST_PRIVILEGED_MEMBER';
export const PROFILE_PAT_LIMIT = 'PROFILE_PAT_LIMIT';

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
      // Clean up the user's PATs and personalization so nothing is orphaned
      // (PATs are dead-safe once the User is gone, but leave no storage leak).
      await PersonalAccessToken.deleteMany({ userId: uid }, { session });
      await UserPreferences.deleteMany({ userId: uid }, { session });
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

  // ── Personal Access Tokens (named, individually revocable) ───────────────

  /** Shape returned to the API (never includes the token secret). */
  private serializePat(doc: PersonalAccessTokenDocument | (PersonalAccessTokenDocument & { _id: unknown })) {
    const now = Date.now();
    const expiresAt = doc.expiresAt instanceof Date ? doc.expiresAt : new Date(doc.expiresAt);
    let status: 'active' | 'expired' | 'revoked';
    if (doc.revoked) status = 'revoked';
    else if (expiresAt.getTime() <= now) status = 'expired';
    else status = 'active';
    return {
      id: String((doc as { _id: unknown })._id),
      jti: doc.jti,
      name: doc.name,
      scope: doc.scope ?? null,
      createdAt: (doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt)).toISOString(),
      expiresAt: expiresAt.toISOString(),
      lastUsedAt: doc.lastUsedAt ? new Date(doc.lastUsedAt).toISOString() : null,
      revoked: doc.revoked,
      status,
    };
  }

  /**
   * Mint a named Personal Access Token: sign a jti-stamped JWT and persist its
   * revocation record. The raw token is returned ONCE (never stored).
   *
   * DURABILITY CAVEAT (cross-service): platform's `requireAuth` special-cases the
   * jti branch to ignore `tokenVersion`, so a PAT survives normal tokenVersion
   * bumps *on platform*. The stateless services (plugin/compliance) validate via
   * the shared Redis tokenVersion revocation store with no jti awareness, so a
   * published bump — password change, admin feature/role change, org soft-delete —
   * DOES invalidate a user's PATs there (i.e. on exactly the services CI PATs
   * target) until they re-issue. This is an accepted trade-off (those events are
   * strong "revalidate credentials" signals); making the stateless path PAT-aware
   * would require it to consult the PersonalAccessToken record, and is deliberately
   * out of scope. Individual PAT revocation (revokePat) works everywhere.
   */
  /** Max active (non-revoked, non-expired) PATs a single user may hold. */
  private readonly MAX_ACTIVE_PATS = 50;

  async createPat(userId: string, name: string, expiresInSeconds: number, scope?: TokenScope) {
    const user = await this.findForTokenIssue(userId);
    // Cap active PATs per user so a compromised session can't mint thousands of
    // durable credentials (mirrors the 20-slot cap on session token history).
    const activeCount = await PersonalAccessToken.countDocuments({ userId: user._id, revoked: false, expiresAt: { $gt: new Date() } });
    if (activeCount >= this.MAX_ACTIVE_PATS) throw new Error(PROFILE_PAT_LIMIT);
    const jti = crypto.randomBytes(16).toString('hex');
    const orgId = user.lastActiveOrgId?.toString();
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const token = await signPersonalAccessToken(user, orgId, jti, expiresInSeconds, scope);
    const doc = await PersonalAccessToken.create({
      userId: user._id,
      jti,
      name,
      scope: scope ?? null,
      organizationId: orgId ?? null,
      expiresAt,
    });
    return { token, pat: this.serializePat(doc) };
  }

  /** List the user's PAT metadata (never the token secret), newest first. */
  async listPats(userId: string) {
    const docs = await PersonalAccessToken.find({ userId }).sort({ createdAt: -1 }).lean();
    return docs.map((d) => this.serializePat(d as unknown as PersonalAccessTokenDocument));
  }

  /** Revoke a single PAT by jti. Returns false if not found or already revoked. */
  async revokePat(userId: string, jti: string): Promise<boolean> {
    const res = await PersonalAccessToken.updateOne(
      { userId, jti, revoked: false },
      { $set: { revoked: true, revokedAt: new Date() } },
    );
    return res.modifiedCount > 0;
  }

  // ── Personalization (server-persisted favorites / recents, per user+org) ──

  private readonly MAX_FAVORITES = 500;
  private readonly MAX_RECENTS = 50;

  /** Read a user's per-org preferences (favorites + recents). Empty when unset. */
  async getPreferences(userId: string, organizationId: string): Promise<{ favorites: string[]; recents: string[] }> {
    const doc = await UserPreferences.findOne({ userId, organizationId }).lean();
    return { favorites: doc?.favorites ?? [], recents: doc?.recents ?? [] };
  }

  /**
   * Replace a user's per-org favorites and/or recents (upsert). Each provided
   * list is de-duplicated and capped. Undefined lists are left unchanged.
   */
  async updatePreferences(
    userId: string,
    organizationId: string,
    patch: { favorites?: string[]; recents?: string[] },
  ): Promise<{ favorites: string[]; recents: string[] }> {
    // Cap element length too (not just array count) so a user can't bloat the
    // document toward the 16MB BSON limit with a few giant strings.
    const clean = (arr: string[], cap: number) =>
      [...new Set(arr.filter((s) => typeof s === 'string' && s && s.length <= 256))].slice(0, cap);
    const set: Record<string, string[]> = {};
    if (patch.favorites !== undefined) set.favorites = clean(patch.favorites, this.MAX_FAVORITES);
    if (patch.recents !== undefined) set.recents = clean(patch.recents, this.MAX_RECENTS);
    const doc = await UserPreferences.findOneAndUpdate(
      { userId, organizationId },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return { favorites: doc?.favorites ?? [], recents: doc?.recents ?? [] };
  }

  /**
   * "Sign out everywhere" — routes through `authService.invalidateAllSessions`,
   * the SAME path auth logout uses, so the profile "revoke all" behaves
   * identically: bump `tokenVersion`, CLEAR the stored `refreshToken` hash, AND
   * publish the revocation to the stateless services. Also revokes the user's
   * PATs (which are decoupled from `tokenVersion`, so a durable credential must
   * be killed explicitly). Returns the user with `tokenVersion` selected so the
   * caller can issue a fresh replacement token.
   */
  async revokeAllSessions(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion issuedTokens');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    // Revoke the DURABLE credentials (PATs) FIRST — if the session-invalidate
    // step below were to throw after PATs were left live, the user would believe
    // "sign out everywhere" succeeded while long-lived tokens still worked.
    await PersonalAccessToken.updateMany(
      { userId: new Types.ObjectId(String(userId)), revoked: false },
      { $set: { revoked: true, revokedAt: new Date() } },
    );
    // Authoritative session revocation: $inc tokenVersion + $unset refreshToken
    // in the DB and publish the revocation (best-effort) — all inside the service.
    await authService.invalidateAllSessions(String(userId));
    // The service bumped tokenVersion via $inc in the DB; mirror that on the doc
    // we return so the caller mints the replacement token at the new version.
    user.tokenVersion += 1;
    return user;
  }
}

export const userProfileService = new UserProfileService();
