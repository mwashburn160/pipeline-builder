// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { apiKeyService } from './api-key-service.js';
import { authService } from './auth-service.js';
import { deleteUserCascade } from './user-cascade.js';
import { PROFILE_USER_NOT_FOUND, PROFILE_EMAIL_TAKEN, PROFILE_INVALID_CREDENTIALS } from './user-errors.js';
import { loadActiveOrgInfo } from '../helpers/active-org-info.js';
import { toOrgId } from '../helpers/org-id.js';
import { assertNewPasswordAcceptable } from '../helpers/password-policy.js';
import { publishUserRevocation, publishUserDeletionRevocation } from '../helpers/session-revocation.js';
import { User, Organization, UserOrganization, type NotificationPreferences, type RefreshSession, UserPreferences } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('user-profile-service');

/** A user's per-org preferences as the API returns them (defaults filled in). */
export interface UserPreferencesView {
  favorites: string[];
  recents: string[];
  notifications: NotificationPreferences;
}

/** A partial update: only the provided fields change. */
export interface PreferencesPatch {
  favorites?: string[];
  recents?: string[];
  notifications?: Partial<NotificationPreferences>;
}

function toPreferencesView(
  doc: { favorites?: string[]; recents?: string[]; notifications?: Partial<NotificationPreferences> } | null | undefined,
): UserPreferencesView {
  return {
    favorites: doc?.favorites ?? [],
    recents: doc?.recents ?? [],
    notifications: { muteQuotaWarnings: doc?.notifications?.muteQuotaWarnings === true },
  };
}

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
  /** The parent's display name (teams only) — lets the switcher label a team
   *  whose parent the user is not a member of. */
  parentOrgName?: string;
  /** Org's quota tier — lets the UI gate tier-gated actions (e.g. only team/enterprise roots may parent teams). */
  tier?: string;
  /** Live (not soft-deleted) teams nested directly under this org. The UI shows
   *  its hierarchy surfaces (team lists, rollup toggles, per-team breakdowns)
   *  only when this is > 0, without a per-page descendants lookup. Nesting is
   *  one level deep, so direct children are all descendants. */
  childOrgCount: number;
  /** Set on a row synthesized for a team the user may enter on admin authority
   *  INHERITED from its parent — no membership row exists (see listOrganizations). */
  viaAncestor?: true;
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
      .select('_id username email isEmailVerified isSuperAdmin lastActiveOrgId featureOverrides tokenVersion mfaResetGraceUntil')
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
   * Every org the user can switch into, as a flat array:
   *   1. their membership rows, sorted by `joinedAt` (oldest first — keeps
   *      "Personal org" at the top of the dashboard switcher);
   *   2. then one `viaAncestor: true` row per LIVE team of an org they
   *      administer (active `admin`/`owner` membership in a live parent) where
   *      they have NO membership row — the teams switch-org admits them to on
   *      inherited authority (helpers/org-authority.ts), with the role that
   *      session gets (`admin`). These rows are synthesized for the switcher
   *      only: no `UserOrganization` row exists, so seats, rosters and every
   *      membership read are unaffected.
   *
   * Three reads regardless of size: memberships, their orgs, and the live
   * children of those orgs (which yields both `childOrgCount` and the
   * inherited-team rows). Parent names of member teams whose parent the user
   * isn't in cost one more read, only when there are such teams.
   */
  async listOrganizations(userId: string): Promise<MembershipInfo[]> {
    const memberships = await UserOrganization.find({ userId }).sort({ joinedAt: 1 }).lean();
    const orgIds = memberships.map(m => m.organizationId);
    if (orgIds.length === 0) return [];
    const orgs = await Organization.find({ _id: { $in: orgIds } }).select('_id name slug parentOrgId tier deletedAt').lean();
    const orgMap = new Map(orgs.map(o => [o._id.toString(), o]));
    // `parentOrgId` is stored as a string id (see the Organization model).
    const children = await Organization.find({ parentOrgId: { $in: orgIds.map(String) }, deletedAt: null })
      .select('_id name slug parentOrgId tier').lean();
    const childCountByOrg = new Map<string, number>();
    for (const c of children) {
      const parent = String(c.parentOrgId);
      childCountByOrg.set(parent, (childCountByOrg.get(parent) ?? 0) + 1);
    }

    // Parent names: from orgs already in hand, reading only the parents the
    // user isn't a member of.
    const nameById = new Map(orgs.map(o => [o._id.toString(), o.name]));
    const missingParents = [...new Set(
      orgs.map(o => (o.parentOrgId ? String(o.parentOrgId) : undefined))
        .filter((p): p is string => !!p && !nameById.has(p)),
    )];
    if (missingParents.length > 0) {
      const parents = await Organization.find({ _id: { $in: missingParents.map(toOrgId) } }).select('_id name').lean();
      for (const p of parents) nameById.set(p._id.toString(), p.name);
    }

    const rows: MembershipInfo[] = memberships.map(m => {
      const org = orgMap.get(m.organizationId.toString());
      const parentOrgId = org?.parentOrgId ? String(org.parentOrgId) : undefined;
      const parentOrgName = parentOrgId ? nameById.get(parentOrgId) : undefined;
      return {
        organizationId: m.organizationId.toString(),
        organizationName: org?.name || 'Unknown',
        slug: org?.slug,
        role: m.role,
        isActive: m.isActive,
        joinedAt: m.joinedAt?.toISOString(),
        ...(parentOrgId && { parentOrgId }),
        ...(parentOrgName && { parentOrgName }),
        ...(org?.tier && { tier: org.tier as string }),
        childOrgCount: childCountByOrg.get(m.organizationId.toString()) ?? 0,
      };
    });

    // Inherited-authority teams (the same rule switch-org applies).
    const memberOrgIds = new Set(orgIds.map(String));
    const administered = new Set(
      memberships
        .filter(m => m.isActive && (m.role === 'admin' || m.role === 'owner'))
        .map(m => m.organizationId.toString())
        .filter(id => !orgMap.get(id)?.deletedAt),
    );
    for (const team of children) {
      const teamId = team._id.toString();
      const parentOrgId = String(team.parentOrgId);
      if (!administered.has(parentOrgId) || memberOrgIds.has(teamId)) continue;
      const parentOrgName = nameById.get(parentOrgId);
      rows.push({
        organizationId: teamId,
        organizationName: team.name,
        slug: team.slug,
        role: 'admin',
        isActive: true,
        parentOrgId,
        ...(parentOrgName && { parentOrgName }),
        ...(team.tier && { tier: team.tier as string }),
        // Nesting is one level deep: a team never parents teams.
        childOrgCount: 0,
        viaAncestor: true,
      });
    }
    return rows;
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
   * Delete the caller's own account and everything keyed to it (see
   * {@link deleteUserCascade}). Throws USER_OWNER_HAS_ORGS,
   * RL_LAST_PRIVILEGED_MEMBER, or PROFILE_USER_NOT_FOUND if the user is already gone.
   */
  async deleteAccount(userId: string): Promise<void> {
    const deleted = await withMongoTransaction((session) => deleteUserCascade(session, userId));
    if (!deleted) throw new Error(PROFILE_USER_NOT_FOUND);
    // Revoke the deleted user's outstanding tokens on the stateless services.
    await publishUserDeletionRevocation(userId, deleted.tokenVersion);
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
    // Org password policy (strictest across the person's orgs) + the
    // breached-password check — throws a 400-shaped PasswordPolicyServiceError.
    await assertNewPasswordAcceptable(newPassword, { userId });

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

  // ── Personalization (server-persisted favorites / recents, per user+org) ──

  private readonly MAX_FAVORITES = 500;
  private readonly MAX_RECENTS = 50;

  /** Read a user's per-org preferences. Defaults when unset. */
  async getPreferences(userId: string, organizationId: string): Promise<UserPreferencesView> {
    const doc = await UserPreferences.findOne({ userId, organizationId }).lean();
    return toPreferencesView(doc);
  }

  /**
   * Update a user's per-org preferences (upsert). Each provided list replaces
   * the stored one, de-duplicated and capped; each provided notification
   * preference is set individually. Anything not provided is left unchanged.
   */
  async updatePreferences(
    userId: string,
    organizationId: string,
    patch: PreferencesPatch,
  ): Promise<UserPreferencesView> {
    // Cap element length too (not just array count) so a user can't bloat the
    // document toward the 16MB BSON limit with a few giant strings.
    const clean = (arr: string[], cap: number) =>
      [...new Set(arr.filter((s) => typeof s === 'string' && s && s.length <= 256))].slice(0, cap);
    const set: Record<string, string[] | boolean> = {};
    if (patch.favorites !== undefined) set.favorites = clean(patch.favorites, this.MAX_FAVORITES);
    if (patch.recents !== undefined) set.recents = clean(patch.recents, this.MAX_RECENTS);
    if (patch.notifications?.muteQuotaWarnings !== undefined) {
      set['notifications.muteQuotaWarnings'] = patch.notifications.muteQuotaWarnings;
    }
    const doc = await UserPreferences.findOneAndUpdate(
      { userId, organizationId },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return toPreferencesView(doc);
  }

  // ── Sessions and devices (refresh-session slots) ─────────────────────────

  /** One refresh-session slot as the API returns it. */
  private serializeSession(slot: RefreshSession) {
    return {
      id: slot.id,
      kind: slot.kind,
      createdAt: new Date(slot.createdAt).toISOString(),
      // For a machine slot this is the last RENEWAL; for an interactive one the
      // last refresh / org switch.
      lastUsedAt: new Date(slot.lastUsedAt).toISOString(),
      signedInAt: new Date(slot.authTime).toISOString(),
      userAgent: slot.userAgent ?? null,
      lastIp: slot.lastIp ?? null,
      scope: slot.scope ?? null,
      // A permission-scoped machine token's subset (null = full permissions).
      permissions: Array.isArray(slot.permissions) ? [...slot.permissions] : null,
      amr: slot.amr ?? [],
    };
  }

  /**
   * The user's live sessions, newest first. Interactive sessions are signed-in
   * devices; machine sessions are the stored credentials `generate-token`
   * opened (listed separately, labelled by scope). IPs are returned as stored —
   * they live only as long as the slot.
   */
  async listSessions(userId: string) {
    const user = await User.findById(userId).select('+refreshSessions').lean();
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    const slots = ((user.refreshSessions ?? []) as RefreshSession[]).map((s) => this.serializeSession(s));
    const byNewest = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);
    return {
      sessions: slots.filter((s) => s.kind === 'interactive').sort(byNewest),
      machineSessions: slots.filter((s) => s.kind === 'machine').sort(byNewest),
    };
  }

  /**
   * Revoke ONE session slot: that device is signed out, or that stored machine
   * credential stops renewing (its current access token still works until it
   * expires — "sign out everywhere" is the immediate kill switch). Returns the
   * revoked slot's kind, or null when the user has no such slot.
   */
  async revokeSession(userId: string, sessionId: string): Promise<{ kind: RefreshSession['kind'] } | null> {
    const slot = ((await User.findOne(
      { '_id': userId, 'refreshSessions.id': sessionId },
      { 'refreshSessions.$': 1 },
    ).lean())?.refreshSessions?.[0]) as RefreshSession | undefined;
    if (!slot) return null;
    await authService.revokeRefreshSession(userId, sessionId);
    return { kind: slot.kind };
  }

  /**
   * "Sign out everywhere" — routes through `authService.invalidateAllSessions`,
   * the SAME path auth logout uses, so the profile "revoke all" behaves
   * identically: bump `tokenVersion`, CLEAR every refresh-session slot, AND
   * publish the revocation to the stateless services. Also revokes the user's
   * access keys (which are decoupled from `tokenVersion`, so a durable
   * credential must be killed explicitly). Returns the user with `tokenVersion`
   * selected so the caller can issue a fresh replacement token.
   */
  async revokeAllSessions(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion issuedTokens');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    // Revoke the DURABLE credentials (access keys) FIRST — if the
    // session-invalidate step below were to throw after keys were left live, the
    // user would believe "sign out everywhere" succeeded while a key kept
    // exchanging for fresh tokens.
    await apiKeyService.revokeAllForUser(userId);
    // Authoritative session revocation: $inc tokenVersion + clear refresh-session slots
    // in the DB and publish the revocation (best-effort) — all inside the service.
    await authService.invalidateAllSessions(String(userId));
    // The service bumped tokenVersion via $inc in the DB; mirror that on the doc
    // we return so the caller mints the replacement token at the new version.
    user.tokenVersion += 1;
    return user;
  }
}

export const userProfileService = new UserProfileService();
